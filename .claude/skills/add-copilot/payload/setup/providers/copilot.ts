import { registerSetupProvider } from './registry.js';

registerSetupProvider({
  value: 'copilot',
  label: 'GitHub Copilot',
  hint: 'Your Copilot plan, through the credential gateway',
  runAuth: async () => {
    // Setup can refresh this payload after loading the registry. Load the
    // helper only when called, so an earlier static import cannot cache it.
    const auth = await import('../../scripts/copilot-auth.js');
    await auth.runCopilotSetupAuth();
  },
  runInstallCheck: async () => {
    const auth = await import('../../scripts/copilot-auth.js');
    await auth.checkCopilotInstall();
  },
});
