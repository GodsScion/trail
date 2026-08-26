import type { Driver } from '../../src/driver/types.js';
import type { AriaNode, DriverRequest, DriverResponse } from '../../src/protocol.js';

export type FakeHandlers = {
  [K in DriverRequest['kind']]?: (req: Extract<DriverRequest, { kind: K }>) => DriverResponse;
};

export function ariaNode(partial: Partial<AriaNode> & { role: string }): AriaNode {
  return { ref: null, name: '', children: [], ...partial };
}

/**
 * A Driver that answers from a handler table instead of a browser. Every request
 * lands in `sent`, so a test can assert on what the code under test did *not*
 * ask for — which is the whole point on the hint-hit path.
 */
export class FakeDriver implements Driver {
  readonly sent: DriverRequest[] = [];

  constructor(private readonly handlers: FakeHandlers = {}) {}

  async send(req: DriverRequest): Promise<DriverResponse> {
    this.sent.push(req);
    const handler = this.handlers[req.kind] as
      | ((r: DriverRequest) => DriverResponse)
      | undefined;
    return handler ? handler(req) : { kind: 'ok' };
  }

  async close(): Promise<void> {}

  kinds(): string[] {
    return this.sent.map((r) => r.kind);
  }
}
