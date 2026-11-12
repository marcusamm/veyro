import { calculateFactory } from './engine';
import { validateFactoryLayout } from './validation';
self.onmessage = (event: MessageEvent<{
    requestId: number;
    layout: unknown;
}>) => {
    const { requestId, layout } = event.data;
    try {
        self.postMessage({ requestId, result: calculateFactory(validateFactoryLayout(layout)) });
    }
    catch (error) {
        self.postMessage({ requestId, error: error instanceof Error ? error.message : 'Calculation unavailable.' });
    }
};
