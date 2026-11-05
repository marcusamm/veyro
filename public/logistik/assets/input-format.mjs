/** Reopen numbers without exponent notation, which the editable Danish parser rejects. */
export function formatInputValue(value){
  if(typeof value!=='number')return value;
  if(!Number.isFinite(value))return '';
  const text=String(value),match=/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if(!match)return text.replace('.',',');
  const [,sign,whole,fraction='',exponent]=match;
  const digits=whole+fraction,point=whole.length+Number(exponent);
  const plain=point<=0?`0.${'0'.repeat(-point)}${digits}`:point>=digits.length?digits+'0'.repeat(point-digits.length):`${digits.slice(0,point)}.${digits.slice(point)}`;
  return (sign+plain).replace('.',',');
}
