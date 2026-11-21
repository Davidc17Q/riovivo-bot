export function sinAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Deja el teléfono en formato internacional sin "+" (como lo usa WhatsApp).
 * Un celular local de 10 dígitos recibe el código de país del tenant.
 */
export function normalizarTelefono(telefono: string, codigoPais = "57"): string {
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length === 10) return `${codigoPais}${digitos}`;
  return digitos;
}

export function formatoPesos(valor: number): string {
  return `$${Math.round(valor).toLocaleString("es-CO")}`;
}

/** Parte un texto largo en trozos que caben en un mensaje de WhatsApp. */
export function partirMensaje(texto: string, limite = 3500): string[] {
  const partes: string[] = [];
  let resto = texto.trim();
  while (resto.length > limite) {
    let corte = resto.lastIndexOf("\n", limite);
    if (corte < limite / 2) corte = resto.lastIndexOf(" ", limite);
    if (corte <= 0) corte = limite;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}
