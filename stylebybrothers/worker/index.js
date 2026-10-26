// Cloudflare Worker for sbb.veyro.dk: statiske filer fra site/ og /api/* til bookingserveren.
import { DurableObject } from 'cloudflare:workers';
import { SalonCore, resendMailer } from './core.js';

function kvStorage(storage) {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    delete: (key) => storage.delete(key),
    list: (prefix) => storage.list({ prefix }),
  };
}

/** Én instans for hele salonen. Den behandler én forespørgsel ad gangen, så en tid kun kan bookes én gang. */
export class Salon extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new SalonCore(kvStorage(ctx.storage), env, resendMailer(env));
  }
  fetch(request) {
    return this.core.handle(request);
  }
}

const salon = (env) => env.SALON.get(env.SALON.idFromName('stylebybrothers'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return salon(env).fetch(request);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(salon(env).fetch('https://salon/internal/cron', { method: 'POST' }));
  },
};
