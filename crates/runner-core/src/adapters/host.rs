use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::adapter::{AdapterFuture, AdapterHost, AgentEvent};
use crate::daemon::Registry;
use crate::protocol::{JobEvent, JobQuestion, RunnerMessage};

pub const QUESTION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

struct PendingQuestion {
    question_id: String,
    options: HashMap<String, String>,
    sender: oneshot::Sender<Value>,
}

#[derive(Default)]
struct Pending {
    answers: HashMap<String, PendingQuestion>,
}

pub struct RunnerHost {
    registry: Arc<Registry>,
    pending: Mutex<Pending>,
}

impl RunnerHost {
    pub fn new(registry: Arc<Registry>) -> Arc<RunnerHost> {
        Arc::new(RunnerHost {
            registry,
            pending: Mutex::new(Pending::default()),
        })
    }

    pub fn answer(&self, job_id: &str, answer: Value) -> bool {
        let mut pending = self.pending.lock().expect("host lock");
        let Some(question) = pending.answers.remove(job_id) else {
            return false;
        };
        let payload = if answer.get("answers").is_some() || answer.get("cancelled").is_some() {
            answer
        } else {
            let Some(option_id) = answer.get("optionId").and_then(Value::as_str) else {
                return false;
            };
            let label = question.options.get(option_id).cloned().or_else(|| {
                answer
                    .get("label")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            let Some(label) = label else {
                return false;
            };
            json!({"answers": [{"id": question.question_id, "selected": [label]}]})
        };
        question.sender.send(payload).is_ok()
    }

    pub fn forget(&self, job_id: &str) {
        self.pending
            .lock()
            .expect("host lock")
            .answers
            .remove(job_id);
    }
}

fn center_event(event: AgentEvent) -> Option<Value> {
    match event {
        AgentEvent::Tool { name, status, .. } => {
            let status = match status.as_str() {
                "started" => "started",
                "finished" => "finished",
                _ => return None,
            };
            Some(json!({"type": "tool", "name": name, "status": status}))
        }
        AgentEvent::Usage {
            input_tokens,
            output_tokens,
            ..
        } => Some(json!({
            "type": "usage",
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
        })),
        AgentEvent::Status { .. } | AgentEvent::Question { .. } | AgentEvent::Log { .. } => None,
    }
}

struct Card {
    payload: Value,
    question_id: String,
    options: HashMap<String, String>,
}

fn option_map(options: &[Value]) -> HashMap<String, String> {
    options
        .iter()
        .filter_map(|option| {
            let id = option.get("id").and_then(Value::as_str)?;
            let label = option.get("label").and_then(Value::as_str)?;
            Some((id.to_string(), label.to_string()))
        })
        .collect()
}

fn card_from_escalation(question: &Value) -> Option<Card> {
    let object = question.as_object()?;
    for key in ["stage", "question", "context", "trigger", "defaultOption"] {
        object.get(key).and_then(Value::as_str)?;
    }
    let options = object.get("options")?.as_array()?;
    Some(Card {
        payload: question.clone(),
        question_id: object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("question")
            .to_string(),
        options: option_map(options),
    })
}

fn card_from_user_question(question: &Value) -> Option<Card> {
    let object = question.as_object()?;
    let stage = object.get("stage").and_then(Value::as_str)?;
    let first = object.get("questions")?.as_array()?.first()?;
    let question_id = first.get("id").and_then(Value::as_str)?;
    let text = first.get("question").and_then(Value::as_str)?;
    let labels: Vec<String> = first
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| option.get("label").and_then(Value::as_str))
                .take(4)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if labels.len() < 2 {
        return None;
    }
    let options: Vec<Value> = labels
        .iter()
        .enumerate()
        .map(|(index, label)| {
            json!({"id": format!("o{}", index + 1), "label": label, "reversible": true})
        })
        .collect();
    let context = first.get("detail").and_then(Value::as_str).unwrap_or(text);
    let payload = json!({
        "stage": stage,
        "question": text,
        "context": context,
        "trigger": "E5",
        "options": options,
        "defaultOption": "o1",
    });
    Some(Card {
        payload,
        question_id: question_id.to_string(),
        options: option_map(&options),
    })
}

fn escalation_card(question: &Value) -> Option<Card> {
    card_from_user_question(question).or_else(|| card_from_escalation(question))
}

impl AdapterHost for RunnerHost {
    fn event(&self, job_id: &str, event: AgentEvent) {
        let Some(event) = center_event(event) else {
            return;
        };
        self.registry.emit(RunnerMessage::JobEvent(JobEvent {
            job_id: job_id.to_string(),
            seq: None,
            event,
        }));
    }

    fn ask<'a>(&'a self, job_id: &'a str, question: Value) -> AdapterFuture<'a, Option<Value>> {
        Box::pin(async move {
            let card = escalation_card(&question)?;
            let (sender, receiver) = oneshot::channel();
            self.pending.lock().expect("host lock").answers.insert(
                job_id.to_string(),
                PendingQuestion {
                    question_id: card.question_id,
                    options: card.options,
                    sender,
                },
            );
            self.registry.emit(RunnerMessage::JobQuestion(JobQuestion {
                job_id: job_id.to_string(),
                seq: None,
                question: card.payload,
            }));
            match tokio::time::timeout(QUESTION_TIMEOUT, receiver).await {
                Ok(Ok(answer)) => Some(answer),
                _ => {
                    self.pending
                        .lock()
                        .expect("host lock")
                        .answers
                        .remove(job_id);
                    None
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RunnerMessage;
    use crate::util::now_iso;
    use serde_json::json;

    fn channel() -> (Arc<RunnerHost>, tokio::sync::mpsc::Receiver<RunnerMessage>) {
        let (sender, receiver) = tokio::sync::mpsc::channel(16);
        let registry = Registry::new();
        registry.set_outbox(sender);
        (RunnerHost::new(registry), receiver)
    }

    #[tokio::test]
    async fn events_are_numbered_per_job_and_forwarded_to_the_transport() {
        let (host, mut outbox) = channel();
        host.event(
            "job-1",
            AgentEvent::Tool {
                name: "read".to_string(),
                status: "started".to_string(),
                at: now_iso(),
            },
        );
        host.event(
            "job-1",
            AgentEvent::Tool {
                name: "read".to_string(),
                status: "finished".to_string(),
                at: now_iso(),
            },
        );
        let first = outbox.recv().await.unwrap();
        let second = outbox.recv().await.unwrap();
        let RunnerMessage::JobEvent(first) = first else {
            panic!("expected a job event");
        };
        let RunnerMessage::JobEvent(second) = second else {
            panic!("expected a job event");
        };
        assert_eq!((first.seq, second.seq), (Some(1), Some(2)));
        assert_eq!(first.job_id, "job-1");
        assert_eq!(first.event["type"], "tool");
        assert_eq!(first.event["status"], "started");
    }

    #[tokio::test]
    async fn a_question_waits_for_the_center_answer() {
        let (host, mut outbox) = channel();
        let asker = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.ask("job-1", escalation()).await })
        };
        let RunnerMessage::JobQuestion(question) = outbox.recv().await.unwrap() else {
            panic!("expected a job question");
        };
        assert_eq!(question.job_id, "job-1");
        assert!(host.answer(
            "job-1",
            json!({"answers": [{"id": "q1", "selected": ["a"]}]})
        ));
        let answer = asker.await.unwrap().unwrap();
        assert_eq!(answer["answers"][0]["selected"][0], "a");
    }

    #[tokio::test]
    async fn a_dsh_question_becomes_an_escalation_and_the_center_answer_reaches_the_agent() {
        let (host, mut outbox) = channel();
        let asker = {
            let host = Arc::clone(&host);
            tokio::spawn(async move { host.ask("job-1", dsh_question()).await })
        };
        let RunnerMessage::JobQuestion(question) = outbox.recv().await.unwrap() else {
            panic!("expected a job question");
        };
        assert_eq!(question.question["stage"], "build");
        assert_eq!(question.question["trigger"], "E5");
        assert_eq!(question.question["options"][1]["label"], "SQLite");
        assert!(host.answer(
            "job-1",
            json!({"escalationId": "esc-1", "optionId": "o2", "label": "SQLite"})
        ));
        let answer = asker.await.unwrap().unwrap();
        assert_eq!(answer["answers"][0]["id"], "q1");
        assert_eq!(answer["answers"][0]["selected"][0], "SQLite");
    }

    #[tokio::test]
    async fn a_question_waits_for_the_center() {
        let (host, _outbox) = channel();
        let expired =
            tokio::time::timeout(Duration::from_millis(50), host.ask("job-1", escalation())).await;
        assert!(expired.is_err(), "the host must wait for the center");
    }

    fn escalation() -> Value {
        json!({
            "id": "esc-1",
            "stage": "build",
            "question": "Which?",
            "context": "Both fit",
            "trigger": "E2",
            "options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
            "defaultOption": "a",
        })
    }

    fn dsh_question() -> Value {
        json!({
            "stage": "build",
            "questions": [{
                "id": "q1",
                "question": "Which store should back the queue?",
                "detail": "Both fit the budget.",
                "options": [{"label": "Postgres"}, {"label": "SQLite"}],
            }],
        })
    }
}
