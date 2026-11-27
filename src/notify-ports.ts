/** The run cycle's outbound notify IO as injectable ports (`RunCycleOptions.notify`); the defaults delegate
 *  lazily to each module namespace. `ntfy.ts`/`email.ts` must never import this file (value-edge cycle). */

import * as email from "./email.js";
import * as ntfy from "./ntfy.js";

export interface NotifyPorts {
  pushNtfy: typeof ntfy.pushNtfy;
  ntfyPushEnabled: typeof ntfy.ntfyPushEnabled;
  sendBandEmail: typeof email.sendBandEmail;
}

const realNotify: NotifyPorts = {
  pushNtfy: (...a) => ntfy.pushNtfy(...a),
  ntfyPushEnabled: (...a) => ntfy.ntfyPushEnabled(...a),
  sendBandEmail: (...a) => email.sendBandEmail(...a),
};

export const resolveNotify = (over: Partial<NotifyPorts> = {}): NotifyPorts => ({ ...realNotify, ...over });
