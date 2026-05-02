export default function App() {
  return (
    <main
      style={{
        minHeight: '100vh',
        margin: 0,
        fontFamily: 'system-ui, sans-serif',
        background: 'linear-gradient(160deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        color: '#e2e8f0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      <div
        style={{
          maxWidth: '24rem',
          textAlign: 'center',
          padding: '2rem',
          borderRadius: '1rem',
          border: '1px solid rgba(148, 163, 184, 0.25)',
          background: 'rgba(15, 23, 42, 0.75)',
        }}
      >
        <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8', marginBottom: '0.75rem' }}>
          Студия · static preview
        </p>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: '0 0 0.75rem' }}>
          Сборка шаблона прошла успешно
        </h1>
        <p style={{ fontSize: '0.875rem', lineHeight: 1.5, color: '#94a3b8', margin: 0 }}>
          Дальше агент сможет подменять файлы в workspace и пересобирать превью.
        </p>
      </div>
    </main>
  );
}
