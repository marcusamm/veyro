// Reusable, entirely fictional newsletter for the browser regression and local visual preview.
export const rasterPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAC0CAIAAADHHcVbAAAFfElEQVR4nO3V0Y0kRRBF0fUGX3AAb8AAnMAgfpH2HyP4RatBsGhGPd1ZmfUyMo50DKhKvdD98sNPP2Z9/fN3AEj5Eg+hFgIQtEUI5RCAlI1CKIcA3G+7EMohAHfaNIRyCMA9tg6hFgKw2u4hlEMAlqoRQjkEYJFKIZRDAKarF0I5BGCiqiHUQgCmKBxCOQTguvIhlEMArjgkhHIIwJijQiiHALzqwBDKIQDPOzaEWgjAM04OoRwC8KnzQyiHADzQJYRyCMCHeoVQDoFN/PXHr8+If2cHHUMoh0DKk/1TxDv1DaEcAncaTqAcrtY9hHII3GBKBbVwESGUQ2ChiQmUw0WEUA6BVRZVUAvnEkI5BJZYWkEtnEgI5RCY74YKauEsQiiHwGS3VVALpxBCOQQmE8JahFAOgZlurqAWXieEcghME6mgFl4khHIITCOEFQmhHAJzBCuohVcIoRwCcwhhUUIoh8AcQliUEMohMEG8glo4TAjlEJggnkAhHCaEcghMEE+gEA4TQjkEJognUAiHCaEcAhPEEyiEw4RQDoEJ4gkUwmFCKIfABPEECuEwIZRDYIJ4AoVwmBBuIb4D4KJ4AoVwmBBuJL4GYFg8gUI4TAi3E98EMCCeQCEcJoSbii8DeEk8gUI4TAi3Ft8H8KR4AoVwmBDWEB8K8CkVLEoIK4nPBXhACIsSwnriowE+JIRFCWFV8ekA76lgRUJYXnxDwL+EsCIhPER8ScAbFSxHCI8S3xPw9fYWxv+3OiE8UHxV0JwQ1iKEJ4vPC9pSwUKE8HzxkUFPKliFEHYRnxo0pIIlCGE78c1BKyq4PyFsKr48aEUCdyaE3cUnCE2o4LaEkG/iQ4QmJHBDQsj/xBcJTejfPoSQD8R3CXAbIeSR+EABVhNCPhefKcA6QsgL4nsFmE4IeVl8tQATCSHj4vMFuE4IuSo+YoArhJBp4msGGCCEzBefNcDzhJBV4uMGeIYQslx85QAPCCH3ic8d4D0h5G7x0QN8TwiJia8f4KsQsoP4GQCdCSEbid8D0JAQsqP4YQB9CCH7ip8H0IEQUkD8ToCDCSGVxA8GOI8QUlL8coBjCCG1xU8IqE4IOUT8loCihJDTxI8KqEUIOVb8uoAShJAW4pcGbEsI6SV+csBuhJCmfvnt58fixwncQwjp7tMi6iWcTQjhPxejKJZQkRDCBxYVUSZhQ0IIj9xZRJmECCGEZ8WjqJGwghDCy+IJFEiYSAjhknj2BBIuEkKYI945gYQxQgjzxdumjvA8IYS14klTR3hMCOE+8ZKpI7wnhJARD5g0whshhLx4uqSRzoQQ9hKPljTSjRDCvuK5kkY6EEKoIR4qaeRUQgj1xBMljZxECKG8eJ90kdKEEI4Sj5MuUo4QwsnicdJF9ieE0Eg8TrrIhoQQ+orHSRfZgRAC/4jHSReJEELgY/E46SL3EELgKfE46SKLCCEwKN4nUWQKIQSmiVdKFxkghMBC8VCJIp8SQuBu8WLpIt8TQiAvHi1R7EwIgX3FAyaKHQghUE88ZqJ4hrc5CSFwjnjYRHFPj2cjhEAX8dSJYip1jwkhwDfx+IniutQ9JoQALxDFQoV7khACrNUqivHXHiCEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALQmhAC0JoQAtCaEALT2N2DcldQ2HQiYAAAAAElFTkSuQmCC';
export const newsletter = {
  id: '1.2', from: 'Atelier Nord <nyheder@example.test>', to: 'you@example.test',
  senderAddress: 'nyheder@example.test', replyAddresses: ['nyheder@example.test'],
  replyAllTo: ['nyheder@example.test'], replyAllCc: [], subject: 'Et lille pusterum til din hverdag',
  date: '2026-11-25T12:00:00Z', unread: false, labels: [], attachments: [], hasAttachments: false,
  has_external_images: true, security: {status: 'clean', reasons: []},
  text: 'Atelier Nord\nEt lille pusterum til din hverdag\nOplev vores nye kollektion med rolige farver og enkle former.\nSe kollektionen: https://atelier.example.test/kollektion\nTo små nyheder: Tid til fordybelse og skabt til hverdagen.',
  html: `<style>
    .newsletter-shell { width:100%; max-width:600px; margin:0 auto; border-collapse:collapse; background:#f8f5ef; color:#173e35; font-family:Arial,sans-serif; }
    .newsletter-pad { padding:28px 32px; }
    .newsletter-heading { margin:0 0 16px; color:#173e35; font:normal 34px/1.15 Georgia,serif; }
    .newsletter-copy { margin:0 0 22px; font-size:16px; line-height:1.65; }
    .newsletter-button { display:inline-block; background:#245a48; color:#fff; border-radius:24px; padding:12px 24px; text-decoration:none; font-size:15px; font-weight:bold; }
    .newsletter-card { width:50%; padding:22px 16px; vertical-align:top; }
    .newsletter-card h2 { font:normal 22px/1.2 Georgia,serif; margin:14px 0 10px; }
    .newsletter-card p { margin:0; font-size:14px; line-height:1.6; }
    @media (max-width:480px) { .newsletter-pad { padding:24px 18px; } .newsletter-heading { font-size:28px; } .newsletter-card { display:block; box-sizing:border-box; width:100%; padding:18px; } }
  </style>
  <table class="newsletter-shell" width="600" cellpadding="0" cellspacing="0" border="0" role="presentation">
    <tr><td class="newsletter-pad" align="center" style="padding-bottom:18px;letter-spacing:3px;font-size:14px;font-weight:bold">ATELIER NORD</td></tr>
    <tr><td><img id="newsletter-hero" data-veyro-src="https://images.example.test/newsletter.png" alt="Rolige grønne bakker i eftermiddagssolen" width="600" height="180" style="display:block;width:100%;height:auto"></td></tr>
    <tr><td class="newsletter-pad"><p style="margin:0 0 14px;font-size:12px;letter-spacing:1.2px;color:#7b6a4c">NYT FRA ATELIERET · NOVEMBER</p>
      <h1 class="newsletter-heading">Et lille pusterum<br>til din hverdag</h1>
      <p class="newsletter-copy">Oplev vores nye kollektion med rolige farver, enkle former og plads til de øjeblikke, der betyder noget.</p>
      <a class="newsletter-button" href="https://atelier.example.test/kollektion">Se kollektionen →</a></td></tr>
    <tr><td style="padding:0 16px"><table class="newsletter-columns" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>
      <td id="newsletter-first-card" class="newsletter-card"><img id="newsletter-inline" data-veyro-part="inline-1" src="data:image/png;base64,${rasterPngBase64}" alt="Landskab i rolige farver" width="248" height="75" style="display:block;width:100%;height:auto"><h2>Tid til fordybelse</h2><p>Små detaljer, der gør en almindelig dag til noget særligt.</p></td>
      <td id="newsletter-second-card" class="newsletter-card"><img id="newsletter-reused-inline" data-veyro-part="inline-1" alt="Landskabet genbrugt fra samme vedhæftede billede" width="248" height="75" style="display:block;width:100%;height:auto"><h2>Skabt til hverdagen</h2><p>Gennemtænkte materialer, som du får lyst til at bruge igen og igen.</p></td>
    </tr></table></td></tr>
    <tr><td align="center" style="padding:26px 20px;background:#e8eadf;font-size:12px;line-height:1.7;color:#526455">Tak, fordi du følger med.<br>Atelier Nord · København<br><a href="https://atelier.example.test/afmeld" style="color:#526455">Afmeld nyhedsbrevet</a></td></tr>
  </table>`,
};
