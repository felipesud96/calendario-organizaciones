// Trimestres del presupuesto: "2026-Q3" = jul-ago-sep de 2026. El
// presupuesto (asignación y gastos) se organiza por trimestre — como cada
// registro queda "amarrado" a su propio trimestre, uno nuevo simplemente no
// tiene todavía asignación ni gastos (parte en cero), sin necesidad de
// ningún proceso de "reinicio": los datos de trimestres anteriores quedan
// intactos, a modo de historial, pero no se cuentan en el saldo del actual.

export function quarterOf(dateInput) {
  const d = typeof dateInput === 'string' ? new Date(dateInput + 'T00:00:00') : dateInput;
  const year = d.getFullYear();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${year}-Q${q}`;
}

export function currentQuarter() {
  return quarterOf(new Date());
}

export function isValidQuarter(q) {
  return /^\d{4}-Q[1-4]$/.test(String(q || ''));
}

export function quarterLabel(quarter) {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return quarter;
  return `${m[2]}° trimestre ${m[1]}`;
}
