// SigV4 signing for Neptune IAM database authentication.
//
// Neptune authenticates a Gremlin WebSocket connection (and its HTTPS endpoints such as /status)
// from the headers of the opening GET request, signed for the `neptune-db` service. The driver
// is then given those headers: `new DriverRemoteConnection(url, { headers })`, as in AWS's
// "Connecting to Neptune using IAM authentication with Gremlin JavaScript" guide.
// The signature is only checked at connect time, so a new connection needs fresh headers.
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export const NEPTUNE_SERVICE = 'neptune-db';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type CredentialsProvider = () => Promise<Credentials>;

export interface SignOptions {
  /** e.g. wss://<endpoint>:8182/gremlin or https://<endpoint>:8182/status */
  url: string;
  region: string;
  credentials: Credentials;
  /** Overrides the signing service name; Neptune always uses the default. Exposed for known-answer tests. */
  service?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/** The credentials a Lambda execution environment provides, read from the environment. */
export const credentialsFromEnv: CredentialsProvider = async () => {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials are not available in the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)');
  }
  return { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY, sessionToken: AWS_SESSION_TOKEN };
};

/** Returns the signed headers for a GET to `url` (wss is signed as https, as Neptune expects). */
export async function signGetHeaders(options: SignOptions): Promise<Record<string, string>> {
  const parsed = new URL(options.url);
  const protocol = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : parsed.protocol;
  const request = new HttpRequest({
    method: 'GET',
    protocol,
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    path: parsed.pathname,
    headers: { host: parsed.host },
  });
  const signer = new SignatureV4({
    service: options.service ?? NEPTUNE_SERVICE,
    region: options.region,
    credentials: options.credentials,
    sha256: Sha256,
    // The default adds an S3-style x-amz-content-sha256 header; Neptune's flow signs only
    // host, x-amz-date and x-amz-security-token (the canonical form the test vector pins).
    applyChecksum: false,
  });
  const signed = await signer.sign(request, { signingDate: options.now });
  return { ...signed.headers };
}
