import { useAutosaveGuard } from './autosave/useAutosave';
import { Composer } from './components/Composer';
import { DocumentList } from './components/DocumentList';
import { DocumentView } from './components/DocumentView';
import { ServerStatus } from './components/ServerStatus';
import { SidebarToggle } from './components/SidebarToggle';
import { confirmDiscardChanges } from './unsavedChanges';
import { useSelectedDocumentId } from './useHashRoute';
import { useSidebar } from './useSidebar';

export const App = () => {
  const [selectedId, select] = useSelectedDocumentId();
  const [sidebarOpen, toggleSidebar] = useSidebar();
  useAutosaveGuard();
  const sidebarToggle = <SidebarToggle open={sidebarOpen} onToggle={toggleSidebar} />;
  const navigate = (id: string | undefined) => {
    if (id === selectedId || confirmDiscardChanges()) {
      if (id !== selectedId) select(id);
      if (sidebarOpen && window.matchMedia('(max-width: 640px)').matches) {
        toggleSidebar();
      }
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
            onCreated={(document) => select(document.id)}
            toolbarStart={sidebarOpen ? undefined : sidebarToggle}
          />
        ) : (
          <DocumentView
            key={selectedId}
            id={selectedId}
            onDeleted={() => select(undefined)}
            onGoBack={() => navigate(undefined)}
            onOpen={(document) => select(document.id)}
            toolbarStart={sidebarOpen ? undefined : sidebarToggle}
          />
        )}
      </main>
      <ServerStatus />
    </div>
  );
};
