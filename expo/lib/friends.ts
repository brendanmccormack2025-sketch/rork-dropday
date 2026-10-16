/** Friends and direct messages: the app's side of supabase/migration-friends-messages.sql. Every rule is enforced there. */
import { supabase } from "@/lib/supabase";
import type { ChatMessage, Conversation, FriendRequest, Person, PersonResult } from "@/lib/friendsCore";

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args ?? {});
  if (error) throw new Error(error.message);
  return data as T;
}

export const myInviteToken = () => rpc<string>("my_invite_token");
export const rotateMyInvite = () => rpc<string>("rotate_my_invite");
export const redeemInvite = (token: string) => rpc<string>("redeem_invite", { p_token: token });

export const searchPeople = (query: string) => rpc<PersonResult[]>("search_people", { p_query: query });
export const myFriends = () => rpc<Array<Person & { since: string }>>("my_friends");
export const myFriendRequests = () => rpc<FriendRequest[]>("my_friend_requests");
export const sendFriendRequest = (to: string) => rpc<"friends" | "requested">("send_friend_request", { p_to: to });
export const respondFriendRequest = (from: string, accept: boolean) => rpc<void>("respond_friend_request", { p_from: from, p_accept: accept });
export const cancelFriendRequest = (to: string) => rpc<void>("cancel_friend_request", { p_to: to });
export const removeFriend = (other: string) => rpc<void>("remove_friend", { p_other: other });
/** Friends never see my testing posts, unless I let this one test them (private, mine only). */
export const friendCanTest = (friend: string) => rpc<boolean>("friend_can_test", { p_friend: friend });
export const setFriendCanTest = (friend: string, on: boolean) => rpc<void>("set_friend_can_test", { p_friend: friend, p_on: on });

export const myConversations = () => rpc<Conversation[]>("my_conversations");
export const myUnreadMessages = () => rpc<number>("my_unread_messages");
export const conversationFor = (other: string) => rpc<string>("chat_conversation_for", { p_other: other });
export const sendMessage = (to: string, body: string) => rpc<string>("send_message", { p_to: to, p_body: body });
export const sendPostToFriend = (to: string, postId: string, note?: string) => rpc<string>("send_post_to_friend", { p_to: to, p_post_id: postId, p_note: note ?? null });
export const friendsForPost = (postId: string) => rpc<Person[]>("friends_for_post", { p_post_id: postId });
export const deleteMyMessage = (id: string) => rpc<void>("delete_my_message", { p_message_id: id });
export const reportMessage = (id: string, reason: "spam" | "harassment" | "nudity" | "other") => rpc<void>("report_message", { p_message_id: id, p_reason: reason });
export const markConversationRead = (other: string) => rpc<void>("mark_conversation_read", { p_other: other });
export const openSharedPost = async (messageId: string): Promise<{ post_id: string | null; available: boolean }> => {
  const rows = await rpc<Array<{ post_id: string | null; available: boolean }>>("open_shared_post", { p_message_id: messageId });
  return rows?.[0] ?? { post_id: null, available: false };
};

/** The newest messages of a conversation, oldest first (RLS: only the two people can read them). */
export async function fetchMessages(conversationId: string, limit = 100): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, conversation_id, sender_id, body, post_id, was_post, created_at, deleted_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as ChatMessage[]).reverse();
}

/** Live new / changed messages of one conversation. Returns the unsubscribe function. */
export function subscribeMessages(conversationId: string, onMessage: (m: ChatMessage) => void): () => void {
  const channel = supabase
    .channel(`chat:${conversationId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages", filter: `conversation_id=eq.${conversationId}` }, (payload) => {
      const row = payload.new as ChatMessage | undefined;
      if (row && row.id) onMessage(row);
    })
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Any change to my chats (a message arrived, was read): for the unread badge and the list. */
export function subscribeAnyMessage(onChange: () => void): () => void {
  const channel = supabase
    .channel(`chat-any:${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages" }, onChange)
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
