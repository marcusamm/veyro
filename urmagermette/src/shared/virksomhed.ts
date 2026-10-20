// Virksomhedens faste oplysninger. Oplysninger, der endnu ikke er bekræftet af ejeren,
// står som null og vises som "bekræftes" på siden.
export const VIRKSOMHED = {
  navn: 'UrmagerMette',
  adresse: 'Holbækvej 54',
  postnr: '4200',
  by: 'Slagelse',
  telefon: '+45 61 67 77 06',
  telefonLink: 'tel:+4561677706',
  email: 'urmagermette@gmail.com',
  domaene: 'urmagermette.dk',
  kortLink: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Holbækvej 54, 4200 Slagelse'),
  ruteLink: 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent('Holbækvej 54, 4200 Slagelse'),
  kortEmbed: 'https://www.google.com/maps?q=' + encodeURIComponent('Holbækvej 54, 4200 Slagelse') + '&output=embed',
  aabningstiderBekraeftet: null as null | string[],
} as const;

export const URTYPER = ['Armbåndsur', 'Vintageur', 'Lommeur', 'Bornholmerur', 'Taffelur', 'Stueur', 'Andet'] as const;
