import { z } from 'zod';
import { IsoDateSchema } from './common.js';

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const SemVerSchema = z.string().regex(SEMVER_PATTERN);
export type SemVer = z.infer<typeof SemVerSchema>;

export const ChannelSchema = z.enum(['stable', 'beta']);
export type Channel = z.infer<typeof ChannelSchema>;

export const UpdateStatusSchema = z.enum(['applied', 'rolled_back', 'failed']);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const TargetSchema = z.enum([
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
]);
export type Target = z.infer<typeof TargetSchema>;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

export const SignatureSchema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
export type Signature = z.infer<typeof SignatureSchema>;

export const UpdateAssetSchema = z
  .object({
    target: TargetSchema,
    fileName: z.string().min(1),
    url: z.url({ protocol: /^https$/ }),
    sizeBytes: z.number().int().positive(),
    sha256: Sha256Schema,
  })
  .strict();
export type UpdateAsset = z.infer<typeof UpdateAssetSchema>;

export const UpdateManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: SemVerSchema,
    channel: ChannelSchema,
    protocolVersion: z.number().int().min(1),
    publishedAt: IsoDateSchema,
    notes: z.string(),
    assets: z.array(UpdateAssetSchema).min(TargetSchema.options.length).max(TargetSchema.options.length),
  })
  .strict()
  .superRefine((manifest, context) => {
    const targets = new Set(manifest.assets.map((asset) => asset.target));
    if (targets.size !== TargetSchema.options.length) {
      context.addIssue('assets must contain each target exactly once');
    }
    const fileNames = new Set(manifest.assets.map((asset) => asset.fileName));
    if (fileNames.size !== manifest.assets.length) {
      context.addIssue('asset fileNames must be unique');
    }
  });
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;

export const ReleasePublishInputSchema = z
  .object({
    manifest: z.string().min(1),
    signature: SignatureSchema,
  })
  .strict();
export type ReleasePublishInput = z.infer<typeof ReleasePublishInputSchema>;

export const RunnerUpdateSchema = z
  .object({
    available: z.boolean(),
    channel: ChannelSchema,
    latestVersion: SemVerSchema.nullable(),
    pinnedVersion: SemVerSchema.nullable(),
    autoUpdate: z.boolean(),
    manifest: z.string().min(1).optional(),
    signature: SignatureSchema.optional(),
    reason: z.string().optional(),
  })
  .strict()
  .superRefine((update, context) => {
    const hasManifest = update.manifest !== undefined;
    const hasSignature = update.signature !== undefined;
    if (update.available && (!hasManifest || !hasSignature)) {
      context.addIssue('an available update requires both manifest and signature');
    }
    if (!update.available && (hasManifest || hasSignature)) {
      context.addIssue('an unavailable update must not carry manifest or signature');
    }
  });
export type RunnerUpdate = z.infer<typeof RunnerUpdateSchema>;

export const UpdatePolicyInputSchema = z
  .object({
    pinnedVersion: SemVerSchema.nullable(),
    autoUpdate: z.boolean(),
  })
  .strict();
export type UpdatePolicyInput = z.infer<typeof UpdatePolicyInputSchema>;

export const UpdateReportInputSchema = z
  .object({
    fromVersion: SemVerSchema,
    toVersion: SemVerSchema,
    status: UpdateStatusSchema,
    reason: z.string().optional(),
  })
  .strict();
export type UpdateReportInput = z.infer<typeof UpdateReportInputSchema>;

export const ReleaseYankInputSchema = z
  .object({
    yanked: z.boolean(),
  })
  .strict();
export type ReleaseYankInput = z.infer<typeof ReleaseYankInputSchema>;

export const RunnerLastUpdateSchema = z
  .object({
    fromVersion: SemVerSchema,
    toVersion: SemVerSchema,
    status: UpdateStatusSchema,
    reason: z.string().nullable(),
    createdAt: IsoDateSchema,
  })
  .strict();
export type RunnerLastUpdate = z.infer<typeof RunnerLastUpdateSchema>;

export const ReleaseSchema = z
  .object({
    version: SemVerSchema,
    channel: ChannelSchema,
    protocolVersion: z.number().int().min(1),
    publishedAt: IsoDateSchema,
    yanked: z.boolean(),
    manifest: z.string().min(1),
    signature: SignatureSchema,
    notes: z.string(),
  })
  .strict();
export type Release = z.infer<typeof ReleaseSchema>;
