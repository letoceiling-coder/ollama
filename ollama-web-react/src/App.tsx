import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ChatLayout } from './components/ChatLayout';
import { LovableStudio } from './pages/LovableStudio';

export default function App() {
  return (
    <BrowserRouter>
      <div className="h-full min-h-[100dvh] text-zinc-100">
        <Routes>
          <Route path="/" element={<ChatLayout />} />
          <Route path="/lovable" element={<LovableStudio />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
