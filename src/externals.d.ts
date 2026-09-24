// hyperswarm / hypercore-crypto are optional peers pulled in by a guarded dynamic import in the
// Bare/Pear auto-dial path, and marked --external in the build. Neither ships types, so declare
// the shape this package actually uses rather than depending on the packages being installed.
declare module 'hyperswarm' {
  interface SwarmDiscovery { flushed(): Promise<void> }
  export default class Hyperswarm {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stream shape is the consumer's to name
    on(event: 'connection', listener: (conn: any) => void): this
    join(topic: Uint8Array, opts?: { client?: boolean; server?: boolean }): SwarmDiscovery
  }
}

declare module 'hypercore-crypto' {
  const crypto: { hash(data: Uint8Array): Uint8Array }
  export default crypto
}
