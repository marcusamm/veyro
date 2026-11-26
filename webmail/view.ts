export function renderUnavailable(installing: boolean): string {
  return `<!doctype html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#f4f2ec">
  <title>Veyro Mail · ${installing ? 'Under opsætning' : 'Forbindelsen er afbrudt'}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/webmail.css">
</head>
<body>
  <main>
    <div class="mail-brand"><img src="/favicon.svg" width="30" height="30" alt="">Veyro Mail</div>
    <h1>${installing ? 'Vi sætter postkasserne op' : 'Ingen forbindelse til mailserveren'}</h1>
    <p>${installing ? 'Du kan se et eksempel på indbakken, mens vi gør den klar.' : 'Prøv at åbne din indbakke igen om lidt.'}</p>
    ${installing ? '<a href="/forhaandsvisning">Se eksempel på indbakken</a>' : '<a href="/">Prøv igen</a>'}
  </main>
</body>
</html>`;
}
