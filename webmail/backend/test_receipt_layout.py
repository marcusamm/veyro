"""Synthetic receipt/layout fixtures. No real messages or external resources."""
import unittest

from message_view import html_view, hydrate_inline_images, image_references


class ReceiptLayout(unittest.TestCase):
    def test_receipt_keeps_layout_buttons_and_responsive_rules(self):
        receipt = """
        <!doctype html><html><head>
        <style>
        body, .receipt { font-family:Arial,sans-serif;color:#272727 }
        .content__cell { padding: 24px 32px; border-bottom:1px solid #ddd }
        .button a {display:inline-block;background:#145233;color:white;border-radius:6px;padding:12px 22px}
        @media only screen and (max-width: 600px) {
          table.receipt {width:100% !important}
          .content__cell {padding:12px}
        }
        </style></head>
        <body id="receipt" class="theme" bgcolor="#f4f4f4" style="font-family:'Open Sans',sans-serif">
          <table role="presentation" class="receipt" width="600" border="0" align="center" cellspacing="0" cellpadding="0">
            <tr><td class="content__cell" bgcolor="#ffffff" valign="middle">
              <img src="//assets.example.test/logo.png" width="120" height="32" alt="Eksempelbutik" title="Logo">
              <table><tr><td class="button"><a href="https://shop.example.test/order">Se ordre</a></td></tr></table>
              <p style="font-size:16px;color:rgb(20, 35, 40)">Ordre 105</p>
            </td></tr></table>
        </body></html>
        """
        safe, text, mismatch = html_view(receipt)
        for wanted in ('class="receipt"', 'class="theme"', 'id="receipt"', 'background-color:#f4f4f4',
                       'font-family:', 'width="600"', 'border="0"', 'align="center"', 'cellspacing="0"',
                       'cellpadding="0"', 'bgcolor="#ffffff"', 'valign="middle"', 'role="presentation"',
                       '.button a{display:inline-block;background:#145233;color:white;border-radius:6px;padding:12px 22px}',
                       '@media only screen and (max-width: 600px){table.receipt{width:100%!important}',
                       'style="font-size:16px;color:rgb(20, 35, 40)"',
                       'data-veyro-src="https://assets.example.test/logo.png"', 'alt="Eksempelbutik"', 'width="120"'):
            self.assertIn(wanted, safe)
        self.assertNotIn(' src=', safe)
        self.assertEqual(image_references(safe), ([], True))
        self.assertIn("Se ordre (https://shop.example.test/order)", text)
        self.assertIn("Eksempelbutik", text)
        self.assertIn("Ordre 105", text)
        self.assertFalse(mismatch)
        for selector in (".receipt", "font-family", "padding:", "@media"):
            self.assertNotIn(selector, text)

    def test_resources_and_unsafe_css_are_stripped_before_rendering(self):
        source = """
        <link rel="stylesheet" href="https://style.invalid/assets.css">
        <style>
        @import "https://style.invalid/import.css";
        @font-face {font-family:sample;src:url("https://fonts.invalid/font")}
        .row {color: navy; background:url("https://image.invalid/tracker"); position:fixed; z-index:10}
        a:visited, img[src] {color:green}
        @media print { .drop {color:teal} }
        </style>
        <table background="https://image.invalid/table"><tr><td style="padding:9px;
          background-image:image-set('https://image.invalid/variant');width:var(--custom);opacity:0">Visible</td></tr></table>
        <a href="https://good.test" ping="https://ping.invalid" target="_top">OK</a>
        <img srcset="https://image.invalid/large 2x" data-veyro-src="https://image.invalid/fake" data-veyro-part="99">
        <img src="data:image/png;base64,YQ=="><img src="/relative.png">
        """
        safe, text, _ = html_view(source)
        self.assertIn('.row{color:navy}', safe)
        self.assertIn('style="padding:9px"', safe)
        self.assertIn("Visible", text)
        for banned in ("style.invalid", "image.invalid", "fonts.invalid", "ping.invalid", "position:",
                       "z-index:", ":visited", "img[src]", "var(", "opacity", "@font-face", "target=", "srcset",
                       "data-veyro-", " src=", "@import", "print", "relative.png"):
            self.assertNotIn(banned, safe)

    def test_inline_raster_references_come_from_verified_mime_sections_only(self):
        source = ('<img src="cid:logo%40example.test" alt="Værksted" data-veyro-part="9">'
                  '<img src="cid:LOGO@example.test"><img src="cid:unrelated"><img src="cid:bad">'
                  '<img alt="data-veyro-part=&quot;7&quot;" data-veyro-src="https://untrusted.test">')
        safe, _, _ = html_view(source, {"logo@example.test": "2.1", "bad": "1.abc"})
        self.assertIn('alt="Værksted"', safe)
        self.assertEqual(safe.count(' data-veyro-part="2.1"'), 2)
        self.assertEqual(image_references(safe), (["2.1"], False))
        self.assertNotIn(' src=', safe)
        self.assertNotIn("untrusted.test", safe)
        self.assertNotIn('data-veyro-part="9"', safe)
        sample = "data:image/png;base64,iVBORw0KGg=="
        rendered = hydrate_inline_images(safe, {"2.1": sample, "9": sample})
        self.assertEqual(rendered.count(' src="' + sample + '"'), 1)
        self.assertEqual(rendered.count(' data-veyro-part="2.1"'), 2)
        self.assertEqual(hydrate_inline_images(safe, {"2.1": "data:image/svg+xml;base64,YQ=="}), safe)
        self.assertEqual(hydrate_inline_images(safe, {"2.1": "https://remote.invalid/"}), safe)

    def test_unsafe_values_cannot_escape_inline_css_or_stylesheet(self):
        safe, text, _ = html_view('<style>.a{color:#123; font-family:"<example>";'
                                  r'background:u\72l(https://ignored.invalid/); margin: -1000px;}'
                                  '</style><div class="a" title="literal &gt; here" style="color:blue;right:20px">Hi</div>')
        self.assertIn(".a{color:#123}", safe)
        self.assertIn('title="literal &gt; here"', safe)
        self.assertNotIn("ignored.invalid", safe)
        self.assertNotIn("margin:", safe)
        self.assertNotIn("right:", safe)
        self.assertEqual(text, "Hi")

    def test_style_elements_keep_media_conditions(self):
        safe, _, _ = html_view('<style media="screen and (min-width: 640px)">.wide{width:640px}</style>'
                               '<style media="print">.print{color:red}</style>'
                               '<style type="text/plain">.text{color:green}</style><p>Test</p>')
        self.assertIn('@media screen and (min-width: 640px){.wide{width:640px}}', safe)
        self.assertNotIn(".print", safe)
        self.assertNotIn(".text", safe)


if __name__ == "__main__":
    unittest.main()
