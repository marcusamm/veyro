/** The mailbox server owns the login form and the authenticated SOGo session. */
export function renderWebmail(ready: boolean, installing = false): string {
  let description = 'Der er ingen forbindelse til mailserveren. Prøv igen om lidt.';
  let action = '<a class="mail-button" href="/">Tjek forbindelsen igen</a>';
  if (ready) {
    description = 'Log ind med din Veyro-mailadresse for at læse og sende mail.';
    action = '<a class="mail-button" href="/SOGo/">Åbn din indbakke</a>';
  } else if (installing) {
    description = 'Postkasserne bliver sat op.';
    action = '';
  }

  return `<!doctype html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#f4f2ec">
  <title>Veyro Mail</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/webmail.css">
</head>
<body>
  <header class="mail-top">
    <div class="mail-brand"><img src="/favicon.svg" width="34" height="34" alt="">Veyro</div>
    <a class="mail-home" href="https://veyro.dk/">Veyros hjemmeside</a>
  </header>
  <main class="mail-desk">
    <section class="mail-entry" aria-labelledby="mail-title">
      <h1 id="mail-title">Veyro Mail<span aria-hidden="true">.</span></h1>
      <p class="mail-description">${description}</p>
      ${action}
      ${!ready && installing ? '<a class="mail-preview-link" href="/forhaandsvisning">Se et eksempel på indbakken</a>' : ''}
    </section>
    <div class="mail-art" aria-hidden="true">
      <div class="mail-envelope">
        <div class="mail-flap"></div>
        <img class="mail-seal" alt="" src="/favicon.svg" width="48" height="48">
        <span class="mail-postmark">mail.veyro.dk</span>
      </div>
    </div>
  </main>
</body>
</html>`;
}
