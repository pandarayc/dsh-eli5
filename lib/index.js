/**
 * dsh-eli5 — host half.
 *
 * Mounts one service and two routes. The service owns the auxiliary model call
 * (own system prompt, own message list, no Session id), so explaining a word the
 * reader does not know can never add a turn to the conversation they are reading.
 *
 * @module dsh-eli5
 */

import { normalizeConfig } from './config.js';
import { createRoutes } from './http.js';
import { Eli5Service } from './service.js';

export const name = 'eli5';

/**
 * No required service: `webServer` is taken with `ctx.inject` below and the LLM
 * service is read per request, because mount order is not ours to choose.
 */
export const inject = [];

/**
 * Mount the host half.
 * @param ctx - Cordis context.
 * @param rawConfig - Loader entry `config`.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const service = new Eli5Service(ctx, config);

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      const disposers = createRoutes(service, config).map((route) => scoped.webServer.register(route));
      try {
        ctx.logger?.info?.(
          `eli5: mounted on /eli5 (provider=${config.provider || 'auto'}, model=${config.model || 'auto'})`,
        );
      } catch {
        // A logger that is unhappy is not a reason to fail a mount.
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'eli5: same-origin routes');
  });
}
