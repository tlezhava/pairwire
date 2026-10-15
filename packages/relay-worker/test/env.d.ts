// Types `env` from "cloudflare:test" with this Worker's bindings.
import type { Env as RelayEnv } from "../src/env.js";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging
    interface Env extends RelayEnv {}
  }
}

export {};
