// The original sealed provisioning record identifies both the agreement and the owner.
export async function updateOwnerEmail(query, provision, change, payloadHash) {
  const { operationId, newEmail, expiresAt } = change;
  if (!/^[a-z0-9_-]{8,80}$/.test(operationId) || operationId === provision.operationId ||
      typeof newEmail !== 'string' || newEmail.length > 254 || newEmail !== newEmail.trim().toLowerCase() ||
      !/^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]{2,}$/.test(newEmail)) {
    throw new Error('Invalid owner email update.');
  }
  const [completed] = await query({ sql: 'SELECT payload_sha256 FROM customer_provisioning_operations WHERE id=?', params: [operationId] });
  if (completed.results.length) {
    if (completed.results[0].payload_sha256 !== payloadHash) throw new Error('Operation ID already used.');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 86400) throw new Error('Email update authorization expired or invalid.');

  const [source, targetCustomers, targetStaff] = await query({ batch: [
    { sql: `SELECT c.id AS customerId, c.email, a.id AS staffId
      FROM customer_provisioning_operations o JOIN customers c ON c.id=o.customer_id
      JOIN subscriptions s ON s.customer_id=c.id JOIN aj_staff a ON a.email=c.email COLLATE NOCASE
      WHERE o.id=? AND o.document_sha256=? AND o.verified=1 AND s.id=? AND s.website_url='https://aj.veyro.dk'
        AND c.email=? AND a.name=? AND a.role='owner' AND a.active=1`,
      params: [provision.operationId, provision.documentSha256, provision.subscriptionId, provision.email, provision.name] },
    { sql: 'SELECT id FROM customers WHERE email=? COLLATE NOCASE', params: [newEmail] },
    { sql: 'SELECT id FROM aj_staff WHERE email=? COLLATE NOCASE', params: [newEmail] },
  ] });
  if (source.results.length !== 1) throw new Error('The original linked owner could not be identified.');
  const { customerId, staffId, email } = source.results[0];
  if (targetCustomers.results.some(c => c.id !== customerId) || targetStaff.results.some(a => a.id !== staffId)) {
    throw new Error('The requested address already belongs to a different account.');
  }
  const batch = [];
  if (email !== newEmail) {
    batch.push(
      { sql: 'UPDATE customers SET email=?,updated_at=unixepoch() WHERE id=? AND email=?', params: [newEmail, customerId, email] },
      { sql: "UPDATE aj_staff SET email=?,calendar_token_hash=NULL WHERE id=? AND email=? AND role='owner' AND active=1",
        params: [newEmail, staffId, email] },
    );
    for (const table of ['sessions', 'login_tokens', 'aj_sessions', 'aj_login_tokens']) {
      batch.push({ sql: `DELETE FROM ${table} WHERE email COLLATE NOCASE IN (?,?)`, params: [email, newEmail] });
    }
  }
  // The verified CHECK rolls the entire batch back if the identities changed during the operation.
  batch.push({ sql: `INSERT INTO customer_provisioning_operations(id,payload_sha256,document_sha256,customer_id,verified)
    VALUES(?,?,?,?,EXISTS(SELECT 1 FROM customers c JOIN aj_staff a ON a.email=c.email
      JOIN subscriptions s ON s.customer_id=c.id
      WHERE c.id=? AND a.id=? AND a.role='owner' AND a.active=1 AND c.email=? AND s.id=?
        AND NOT EXISTS(SELECT 1 FROM customers other WHERE other.id<>c.id AND other.email=c.email COLLATE NOCASE)))`,
    params: [operationId, payloadHash, provision.documentSha256, customerId, customerId, staffId, newEmail, provision.subscriptionId] });
  await query({ batch });
  const [verified] = await query({ sql: `SELECT o.verified FROM customer_provisioning_operations o
    JOIN customers c ON c.id=o.customer_id JOIN aj_staff a ON a.email=c.email
    WHERE o.id=? AND o.payload_sha256=? AND c.id=? AND a.id=? AND a.role='owner' AND a.active=1 AND c.email=?`,
    params: [operationId, payloadHash, customerId, staffId, newEmail] });
  if (verified.results.length !== 1) throw new Error('Could not verify the new login address after the update.');
  console.log('Verified owner login in the existing customer account and workshop calendar.');
}
