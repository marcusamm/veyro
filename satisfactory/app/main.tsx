import React from 'react';
import { createRoot } from 'react-dom/client';
import AccountApp from './AccountApp';
import './globals.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><AccountApp/></React.StrictMode>);
