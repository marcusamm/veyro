import { themeCheckRun } from '@shopify/theme-check-node';
const r = await themeCheckRun(process.argv[2], undefined, () => {});
const offenses = r.offenses ?? r;
for (const o of offenses) console.log(o.severity, o.check, o.uri?.split('theme-live/')[1], o.start?.line, o.message);
console.log('total', offenses.length);
