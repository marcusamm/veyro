// Små hjælpere til at kalde serveren.
export class ApiFejl extends Error {
  constructor(public status: number, besked: string, public felter: Record<string, string> = {}) {
    super(besked);
  }
}

export async function api<T>(sti: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  if (sti.startsWith('/api/admin')) headers.set('x-um', '1');
  let res: Response;
  try {
    res = await fetch(sti, { ...init, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiFejl(0, 'Der er ingen forbindelse til serveren. Tjek din internetforbindelse og prøv igen.');
  }
  const data = (await res.json().catch(() => ({}))) as { fejl?: string; felter?: Record<string, string> };
  if (!res.ok) throw new ApiFejl(res.status, data.fejl ?? 'Der opstod en fejl. Prøv igen.', data.felter ?? {});
  return data as T;
}
