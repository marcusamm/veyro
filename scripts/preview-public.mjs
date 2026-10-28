// Isoleret lokal preview med midlertidig database og mock-Stripe/Resend.
// Ingen forbindelse til produktionsdata eller rigtige betalinger/e-mails.
import { startStack } from '../tests/harness.mjs';
const stack = await startStack({ minMonths: 0 });
console.log(`Veyro lokal preview: ${stack.site}`);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await stack.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
