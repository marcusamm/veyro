import { solveProductionPlan, type ProductionRequest } from './production';

self.onmessage = (event: MessageEvent<{ requestId: number; request: ProductionRequest }>) => {
  const { requestId, request } = event.data;
  try {
    self.postMessage({ requestId, result: solveProductionPlan(request) });
  } catch (error) {
    self.postMessage({ requestId, error: error instanceof Error ? error.message : 'The production plan could not be calculated. Check its settings and try again.' });
  }
};

