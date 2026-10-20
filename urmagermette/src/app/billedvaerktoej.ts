// Gør kundens billede mindre i browseren (maks. 1600 px, JPEG), før det sendes.
// Det fjerner samtidig metadata som GPS-position fra mobilbilleder.
export async function komprimerBillede(fil: File, maks = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(fil).catch(async () => {
    // Ældre browsere: via <img>
    const url = URL.createObjectURL(fil);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  const b = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  const h = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  const skala = Math.min(1, maks / Math.max(b, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(b * skala);
  canvas.height = Math.round(h * skala);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Intet canvas');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const kvalitet of [0.85, 0.72, 0.6]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', kvalitet));
    if (blob && blob.size < 1.8 * 1024 * 1024) return blob;
  }
  throw new Error('For stort');
}
