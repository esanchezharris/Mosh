import { brainChat, pickFiles, pickSaveFile } from "../bridge";
import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { FILE_MENU, runAction, type ActionCtx, type ActionId } from "../menuActions";
import { useStore } from "../store";

const actionContext = (): ActionCtx => ({
  store: useStore.getState(),
  pickFiles,
  pickSaveFile,
  chat: brainChat,
});

export function ProToolsSessionMenu() {
  const run = (id: ActionId) => void runAction(id, actionContext());

  return (
    <MoshMenu
      label="Session actions"
      trigger={
        <button type="button" className="pt-session-button" data-testid="pt-session-menu">
          Session
        </button>
      }
    >
      <div className="pt-menu" role="menu" data-testid="pt-session-actions">
        {FILE_MENU.map((item) => (
          <MoshMenuItem key={item.id} ariaLabel={`${item.label} ${item.accel}`} onPick={() => run(item.id)}>
            <span className="pt-session-action" data-pt-session-action={item.id}>
              <span>{item.label}</span>
              <kbd>{item.accel}</kbd>
            </span>
          </MoshMenuItem>
        ))}
      </div>
    </MoshMenu>
  );
}
