import { solveProductionPlan, type ProductionRequest } from './production';

self.onmessage = (event: MessageEvent<{ requestId: number; request: ProductionRequest }>) => {
  const { requestId, request } = event.data;
  self.postMessage({ requestId, result: solveProductionPlan(request) });
};
