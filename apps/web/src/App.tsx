import { useState } from 'react';
import { Composer } from './components/Composer';
import { DocumentList } from './components/DocumentList';
import { DocumentView } from './components/DocumentView';
import { SidebarToggle } from './components/SidebarToggle';
import { confirmDiscardChanges } from './unsavedChanges';
import { useSelectedDocumentId } from './useHashRoute';
import { updateSessionWords } from './sessionWords';
import { useSidebar } from './useSidebar';

export const App = () => {
  const [sessionWords, setSessionWords] = useState(0);
  const recordWords = (before: string, after: string) =>
    setSessionWords((count) => updateSessionWords(count, before, after));
  const [selectedId, select] = useSelectedDocumentId();
  const [sidebarOpen, toggleSidebar] = useSidebar();
  const sidebarToggle = <SidebarToggle open={sidebarOpen} onToggle={toggleSidebar} />;
  const navigate = (id: string | undefined) => {
    if (id !== selectedId && confirmDiscardChanges()) {
      select(id);
    }
  };

  return (
    <div className={sidebarOpen ? 'layout' : 'layout sidebar-collapsed'}>
      <aside className="sidebar" hidden={!sidebarOpen}>
        <header className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>Reviewr</span>
          <span className="spacer" />
          {sidebarToggle}
        </header>
        <button className="primary" onClick={() => navigate(undefined)}>
          + New document
        </button>
        <DocumentList selectedId={selectedId} onSelect={navigate} />
      </aside>
      <main className="content">
        {selectedId === undefined ? (
          <Composer
            sessionWords={sessionWords}
            recordWords={recordWords}
            onCreated={(document) => select(document.id)}
            toolbarStart={sidebarOpen ? undefined : sidebarToggle}
          />
        ) : (
          <DocumentView
            sessionWords={sessionWords}
            recordWords={recordWords}
            key={selectedId}
            id={selectedId}
            onDeleted={() => select(undefined)}
            toolbarStart={sidebarOpen ? undefined : sidebarToggle}
          />
        )}
      </main>
    </div>
  );
};
