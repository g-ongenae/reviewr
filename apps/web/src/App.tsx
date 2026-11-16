import { useAutosaveGuard, useBlankPage } from './autosave/useAutosave';
import { DocumentList } from './components/DocumentList';
import { DocumentView } from './components/DocumentView';
import { LocalCopyNotice } from './components/LocalCopyNotice';
import { ServerStatus } from './components/ServerStatus';
import { SidebarToggle } from './components/SidebarToggle';
import { confirmDiscardChanges } from './unsavedChanges';
import { useSelectedDocumentId } from './useHashRoute';
import { useSidebar } from './useSidebar';

export const App = () => {
  const [selectedId, select] = useSelectedDocumentId();
  /**
   * The blank page: a document that does not exist yet, created by its first save. Once created, it keeps its page
   * (same id, same editor) and takes its address; the next blank page gets a new id, or is a page restored from this
   * device that is not created yet.
   */
  const [blankId, setBlankId] = useBlankPage(selectedId);
  const id = selectedId ?? blankId;
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
        {/* The same element before and after the blank page is created: the writer keeps typing in it. */}
        <DocumentView
          key={id}
          id={id}
          blank={id === blankId}
          onCreated={() => {
            if (selectedId === undefined) select(id, true);
          }}
          onCreateAgain={setBlankId}
          onDeleted={() => select(undefined)}
          onGoBack={() => navigate(undefined)}
          onOpen={(document) => select(document.id)}
          toolbarStart={sidebarOpen ? undefined : sidebarToggle}
        />
      </main>
      <ServerStatus>
        <LocalCopyNotice />
      </ServerStatus>
    </div>
  );
};
