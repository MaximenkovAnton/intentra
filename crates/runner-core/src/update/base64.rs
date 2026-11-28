use super::UpdateError;

fn digit(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub(crate) fn decode(input: &str, field: &'static str) -> Result<Vec<u8>, UpdateError> {
    let bytes = input.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err(UpdateError::Base64Invalid { field });
    }
    let padding = if bytes.ends_with(b"==") {
        2
    } else if bytes.ends_with(b"=") {
        1
    } else {
        0
    };
    let content = bytes.len() - padding;
    let mut output = Vec::with_capacity(content / 4 * 3 + 2);
    let mut buffer = 0u32;
    let mut digits = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if index >= content {
            if *byte != b'=' {
                return Err(UpdateError::Base64Invalid { field });
            }
            continue;
        }
        let Some(value) = digit(*byte) else {
            return Err(UpdateError::Base64Invalid { field });
        };
        buffer = (buffer << 6) | u32::from(value);
        digits += 1;
        if digits == 4 {
            output.push((buffer >> 16) as u8);
            output.push((buffer >> 8) as u8);
            output.push(buffer as u8);
            buffer = 0;
            digits = 0;
        }
    }
    match digits {
        0 => {}
        2 => output.push((buffer >> 4) as u8),
        3 => {
            output.push((buffer >> 10) as u8);
            output.push((buffer >> 2) as u8);
        }
        _ => return Err(UpdateError::Base64Invalid { field }),
    }
    Ok(output)
}
