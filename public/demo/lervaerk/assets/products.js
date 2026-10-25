// Lerværk (fiktivt designkoncept): sortiment, lager og fragt til kurv og kasse. Genereres af build.py.
window.LERVAERK = {
 "products": [
  {
   "id": "krus",
   "no": "01",
   "name": "Krus",
   "vlabel": "Glasur",
   "variants": [
    {
     "id": "sand",
     "name": "Sand",
     "price": 245,
     "stock": 8,
     "img": "krus-sand"
    },
    {
     "id": "skovgroen",
     "name": "Skovgrøn",
     "price": 245,
     "stock": 3,
     "img": "krus-skovgron"
    },
    {
     "id": "blaagraa",
     "name": "Blågrå",
     "price": 245,
     "stock": 0,
     "img": "krus-blagra"
    }
   ]
  },
  {
   "id": "espressokop",
   "no": "02",
   "name": "Espressokop",
   "vlabel": "Antal",
   "variants": [
    {
     "id": "1",
     "name": "1 stk.",
     "price": 165,
     "stock": 12,
     "img": "espressokop"
    },
    {
     "id": "2",
     "name": "Sæt med 2",
     "price": 310,
     "stock": 5,
     "img": "espressokop"
    }
   ]
  },
  {
   "id": "morgenmadsskaal",
   "no": "03",
   "name": "Morgenmadsskål",
   "vlabel": "Størrelse",
   "variants": [
    {
     "id": "14",
     "name": "Ø 14 cm",
     "price": 225,
     "stock": 10,
     "img": "skal"
    },
    {
     "id": "17",
     "name": "Ø 17 cm",
     "price": 275,
     "stock": 4,
     "img": "skal"
    }
   ]
  },
  {
   "id": "serveringsskaal",
   "no": "04",
   "name": "Serveringsskål",
   "vlabel": null,
   "variants": [
    {
     "id": "std",
     "name": "Ø 26 cm",
     "price": 545,
     "stock": 2,
     "img": "serveringsskal"
    }
   ]
  },
  {
   "id": "frokosttallerken",
   "no": "05",
   "name": "Frokosttallerken",
   "vlabel": null,
   "variants": [
    {
     "id": "std",
     "name": "Ø 21 cm",
     "price": 235,
     "stock": 9,
     "img": "frokosttallerken"
    }
   ]
  },
  {
   "id": "middagstallerken",
   "no": "06",
   "name": "Middagstallerken",
   "vlabel": null,
   "variants": [
    {
     "id": "std",
     "name": "Ø 27 cm",
     "price": 295,
     "stock": 6,
     "img": "middagstallerken"
    }
   ]
  },
  {
   "id": "kande",
   "no": "07",
   "name": "Kande",
   "vlabel": null,
   "variants": [
    {
     "id": "std",
     "name": "1 liter",
     "price": 595,
     "stock": 0,
     "img": "kande"
    }
   ]
  },
  {
   "id": "serveringsfad",
   "no": "08",
   "name": "Serveringsfad",
   "vlabel": null,
   "variants": [
    {
     "id": "std",
     "name": "34 × 22 cm",
     "price": 495,
     "stock": 3,
     "img": "fad"
    }
   ]
  }
 ],
 "shipping": {
  "pakkeshop": 49,
  "afhent": 0,
  "freeOver": 800
 }
};
