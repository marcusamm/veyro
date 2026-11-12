import { createEmptyFactoryLayout } from '../app/factory/types';
import { validateFactoryLayout } from '../app/factory/validation';
import { PlanValidationError, readPlanUpdate } from '../app/lib/plan-validation';

type LayoutRow = { data:string; revision:number; updated_at:string|null; updated_by:string|null };
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie'}});
const reply = (row:LayoutRow) => ({data:JSON.parse(row.data),revision:row.revision,updatedAt:row.updated_at,updatedBy:row.updated_by});

async function current(db:D1Database):Promise<LayoutRow> {
  await db.prepare('INSERT INTO factory_layouts(id,data,revision) VALUES(1,?,0) ON CONFLICT(id) DO NOTHING').bind(JSON.stringify(createEmptyFactoryLayout())).run();
  const row=await db.prepare('SELECT data,revision,updated_at,updated_by FROM factory_layouts WHERE id=1').first<LayoutRow>();
  if(!row)throw new Error('Factory layout unavailable');
  return row;
}

// Called only after the shared same-origin and active-session checks in index.ts.
export async function factoryApi(request:Request,db:D1Database,userId:string):Promise<Response> {
  if(request.method==='GET')return json(reply(await current(db)));
  if(request.method!=='PUT')return json({error:'Use GET or PUT.'},405);
  const body=await readPlanUpdate(request);
  if(!body||typeof body!=='object'||Array.isArray(body))throw new PlanValidationError('Send a factory layout and revision.');
  const value=body as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['data','revision'].includes(key)))throw new PlanValidationError('The request contains unsupported fields.');
  if(!Number.isSafeInteger(value.revision)||Number(value.revision)<0||Number(value.revision)>=Number.MAX_SAFE_INTEGER)throw new PlanValidationError('Invalid factory revision.');
  let data;
  try { data=validateFactoryLayout(value.data); }
  catch(error) { throw new PlanValidationError(error instanceof Error?error.message:'Invalid factory layout.'); }
  await current(db);
  const row=await db.prepare('UPDATE factory_layouts SET data=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=1 AND revision=? RETURNING data,revision,updated_at,updated_by')
    .bind(JSON.stringify(data),new Date().toISOString(),userId,value.revision).first<LayoutRow>();
  if(!row)return json({error:'Someone saved a newer factory layout. Export your draft before loading their changes.',code:'revision_conflict'},409);
  return json(reply(row));
}
