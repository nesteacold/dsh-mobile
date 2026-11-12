// Spec 011 parity: the conversation list is now the app's single main screen (`index`), so this route
// only exists for backwards-compatible pushes. It redirects instead of rendering a second list.
import { Redirect } from 'expo-router';

export default function ConversationsRedirect() {
  return <Redirect href="/" />;
}