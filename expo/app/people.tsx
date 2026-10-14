import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, Share, StyleSheet, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";

import { FeedAvatar } from "@/components/Avatar";
import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { listContactsToInvite, type InviteContact } from "@/lib/contacts";
import {
  cancelFriendRequest,
  myFriendRequests,
  myFriends,
  removeFriend,
  respondFriendRequest,
  searchPeople,
  sendFriendRequest,
} from "@/lib/friends";
import { friendlyError, inviteMessage, relationLabel, smsHref, type FriendRequest, type Person, type PersonResult } from "@/lib/friendsCore";
import { myInvite } from "@/lib/invite";

/** Friends: my invite link, requests, username search, my friends, and (optionally) contacts to invite. */
export default function PeopleScreen() {
  const router = useRouter();
  const [friends, setFriends] = useState<Array<Person & { since: string }>>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonResult[]>([]);
  const [contacts, setContacts] = useState<InviteContact[] | null>(null);
  const [contactsNote, setContactsNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [f, r] = await Promise.all([myFriends(), myFriendRequests()]);
      setFriends(f ?? []);
      setRequests(r ?? []);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    const term = query.trim().replace(/^@/, "");
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      searchPeople(term)
        .then((rows) => setResults(rows ?? []))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      if (query.trim().length >= 2) setResults(await searchPeople(query.trim().replace(/^@/, "")));
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const shareMyLink = async () => {
    try {
      const invite = await myInvite();
      await Share.share({ message: invite.message });
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const inviteContact = async (c: InviteContact) => {
    try {
      const invite = await myInvite();
      const href = smsHref(c.number, inviteMessage(invite.link), Platform.OS);
      await Linking.openURL(href);
    } catch {
      // no Messages here: the link can still be shared another way
      void shareMyLink();
    }
  };

  const chooseContacts = async () => {
    setContactsNote(null);
    try {
      const res = await listContactsToInvite();
      if (res.status === "unavailable") setContactsNote("Contacts aren't available in this version of the app. Share your invite link instead.");
      else if (res.status === "denied") setContactsNote("No problem. Share your invite link or search by username.");
      else setContacts(res.contacts);
    } catch {
      setContactsNote("Couldn't read your contacts.");
    }
  };

  const incoming = requests.filter((r) => r.direction === "incoming");
  const outgoing = requests.filter((r) => r.direction === "outgoing");

  return (
    <SettingsScaffold title="Friends">
      <Pressable onPress={shareMyLink} style={s.button} accessibilityRole="button" accessibilityLabel="Invite friends with your link">
        <UiText style={s.buttonText}>Invite friends</UiText>
      </Pressable>
      <UiText style={s.text}>Anyone who opens your link becomes your friend. Friends can message you and send you posts.</UiText>
      {error ? <UiText style={s.error}>{error}</UiText> : null}

      {incoming.length > 0 ? <UiText style={s.heading}>Requests</UiText> : null}
      {incoming.map((r) => (
        <View key={r.id} style={styles.row}>
          <FeedAvatar profile={r} name={r.display_name ?? r.username} />
          <UiText style={styles.name} numberOfLines={1}>
            @{r.username}
          </UiText>
          <Pressable onPress={() => void run(() => respondFriendRequest(r.id, true))} style={styles.pill} accessibilityLabel={`Accept ${r.username}`}>
            <UiText style={styles.pillText}>Accept</UiText>
          </Pressable>
          <Pressable onPress={() => void run(() => respondFriendRequest(r.id, false))} hitSlop={8} accessibilityLabel={`Decline ${r.username}`}>
            <UiText style={styles.muted}>Decline</UiText>
          </Pressable>
        </View>
      ))}

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search usernames"
        placeholderTextColor={theme.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        style={s.input}
      />
      {results.map((p) => (
        <View key={p.id} style={styles.row}>
          <FeedAvatar profile={p} name={p.display_name ?? p.username} />
          <UiText style={styles.name} numberOfLines={1}>
            @{p.username}
          </UiText>
          {p.relation === "friend" ? (
            <UiText style={styles.muted}>{relationLabel("friend")}</UiText>
          ) : p.relation === "requested" ? (
            <Pressable onPress={() => void run(() => cancelFriendRequest(p.id))} hitSlop={8}>
              <UiText style={styles.muted}>{relationLabel("requested")}</UiText>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void run(() => (p.relation === "incoming" ? respondFriendRequest(p.id, true) : sendFriendRequest(p.id)))}
              style={styles.pill}
              accessibilityLabel={`${relationLabel(p.relation)} ${p.username}`}
            >
              <UiText style={styles.pillText}>{relationLabel(p.relation)}</UiText>
            </Pressable>
          )}
        </View>
      ))}

      <UiText style={s.heading}>Your friends</UiText>
      {loading ? <ActivityIndicator color={theme.accent} /> : friends.length === 0 ? <UiText style={s.text}>No friends yet. Share your link to add some.</UiText> : null}
      {friends.map((f) => (
        <View key={f.id} style={styles.row}>
          <Pressable style={styles.rowMain} onPress={() => router.push(`/messages/${f.id}` as never)} accessibilityLabel={`Message ${f.username}`}>
            <FeedAvatar profile={f} name={f.display_name ?? f.username} />
            <UiText style={styles.name} numberOfLines={1}>
              @{f.username}
            </UiText>
          </Pressable>
          <Pressable onPress={() => void run(() => removeFriend(f.id))} hitSlop={8} accessibilityLabel={`Remove ${f.username}`}>
            <UiText style={styles.muted}>Remove</UiText>
          </Pressable>
        </View>
      ))}
      {outgoing.length > 0 ? <UiText style={s.heading}>Sent requests</UiText> : null}
      {outgoing.map((r) => (
        <View key={r.id} style={styles.row}>
          <FeedAvatar profile={r} name={r.display_name ?? r.username} />
          <UiText style={styles.name} numberOfLines={1}>
            @{r.username}
          </UiText>
          <Pressable onPress={() => void run(() => cancelFriendRequest(r.id))} hitSlop={8}>
            <UiText style={styles.muted}>Cancel</UiText>
          </Pressable>
        </View>
      ))}

      <UiText style={s.heading}>Invite from your contacts</UiText>
      <UiText style={s.text}>
        Optional. Your contacts stay on your phone: this only lets you pick someone to send your invite link to. Nothing is uploaded and Tryal never tells you who is already on it.
      </UiText>
      {contacts === null ? (
        <Pressable onPress={chooseContacts} style={s.secondary} accessibilityRole="button">
          <UiText style={s.secondaryText}>Choose from contacts</UiText>
        </Pressable>
      ) : null}
      {contactsNote ? <UiText style={s.text}>{contactsNote}</UiText> : null}
      {(contacts ?? []).slice(0, 300).map((c) => (
        <View key={c.id} style={styles.row}>
          <UiText style={styles.name} numberOfLines={1}>
            {c.name}
          </UiText>
          <Pressable onPress={() => void inviteContact(c)} style={styles.pill} accessibilityLabel={`Invite ${c.name}`}>
            <UiText style={styles.pillText}>Invite</UiText>
          </Pressable>
        </View>
      ))}
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
  rowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  name: { flex: 1, color: theme.text, fontSize: 15, fontWeight: "600" },
  pill: { minWidth: 64, height: 32, borderRadius: 16, paddingHorizontal: 14, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  pillText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  muted: { color: theme.textMuted, fontSize: 13, fontWeight: "700" },
});
