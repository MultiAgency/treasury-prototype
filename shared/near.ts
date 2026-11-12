/** A FastNear API key, when set, goes in a header (not the URL) on RPC and indexer calls. */
export const fastnearHeaders: Record<string, string> = process.env.FASTNEAR_API_KEY
  ? { Authorization: `Bearer ${process.env.FASTNEAR_API_KEY}` }
  : {};

/** How every `Near` client here reaches mainnet: the keyed FastNear host when there is a key. */
export const mainnet = {
  network: {
    rpcUrl: process.env.NEAR_RPC_URL ?? (process.env.FASTNEAR_API_KEY ? "https://rpc.mainnet.fastnear.com" : "https://free.rpc.fastnear.com"),
    networkId: "mainnet",
  },
  headers: fastnearHeaders,
};
