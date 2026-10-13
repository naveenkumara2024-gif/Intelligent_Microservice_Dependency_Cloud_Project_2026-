// Channel credentials from SSM Parameter Store (SecureString), cached briefly per execution
// environment. A missing parameter is a normal state ("channel not switched on"), any other error
// (AccessDenied, throttling) throws so the retry/DLQ path engages instead of silently dropping alerts.
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { SECRET_MISSING_TTL_MS, SECRET_TTL_MS } from './config';

export interface SecretSource {
  /** The decrypted value, or undefined if the parameter does not exist. */
  get(name: string): Promise<string | undefined>;
}

export class SsmSecretSource implements SecretSource {
  private readonly cache = new Map<string, { value: string | undefined; expiresMs: number }>();

  constructor(
    private readonly client: SSMClient,
    private readonly now: () => number = Date.now,
  ) {}

  async get(name: string): Promise<string | undefined> {
    const hit = this.cache.get(name);
    if (hit && hit.expiresMs > this.now()) return hit.value;

    let value: string | undefined;
    try {
      const res = await this.client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      value = res.Parameter?.Value?.trim() || undefined;
    } catch (err) {
      if (!(err instanceof ParameterNotFound) && (err as Error)?.name !== 'ParameterNotFound') throw err;
      value = undefined;
    }
    this.cache.set(name, { value, expiresMs: this.now() + (value ? SECRET_TTL_MS : SECRET_MISSING_TTL_MS) });
    return value;
  }
}
