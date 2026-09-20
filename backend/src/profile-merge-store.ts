import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import type { ProfileMerge } from "./types.js";

interface CreateProfileMergeInput {
  conversationIds: string[];
  displayName?: string;
  sendConversationId?: string;
}

interface UpdateProfileMergeInput {
  displayName?: string;
  sendConversationId?: string | null;
}

export class ProfileMergeStore {
  private profiles: ProfileMerge[];

  constructor(private readonly storagePath?: string) {
    this.profiles = this.load();
  }

  list(): ProfileMerge[] {
    return this.profiles.map(copyProfile);
  }

  get(profileId: string): ProfileMerge | undefined {
    const profile = this.profiles.find(({ id }) => id === profileId);
    return profile ? copyProfile(profile) : undefined;
  }

  profileForConversation(conversationId: string): ProfileMerge | undefined {
    const profile = this.profiles.find(({ conversationIds }) => conversationIds.includes(conversationId));
    return profile ? copyProfile(profile) : undefined;
  }

  create(input: CreateProfileMergeInput): ProfileMerge {
    const conversationIds = [...new Set(input.conversationIds)];
    if (conversationIds.length < 2) {
      throw new AppError("Choose at least two direct messages to merge", 400, "INVALID_PROFILE_MERGE");
    }
    const assigned = conversationIds.find((id) => this.profileForConversation(id));
    if (assigned) {
      throw new AppError("A selected direct message already belongs to a merged profile", 409, "PROFILE_ALREADY_MERGED");
    }
    if (input.sendConversationId && !conversationIds.includes(input.sendConversationId)) {
      throw new AppError("The send override must be one of the merged direct messages", 400, "INVALID_SEND_OVERRIDE");
    }

    const profile: ProfileMerge = {
      id: `profile:${randomUUID()}`,
      conversationIds,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.sendConversationId ? { sendConversationId: input.sendConversationId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.profiles.push(profile);
    this.save();
    return copyProfile(profile);
  }

  update(profileId: string, input: UpdateProfileMergeInput): ProfileMerge {
    const index = this.profiles.findIndex(({ id }) => id === profileId);
    if (index < 0) throw new AppError("Merged profile not found", 404, "PROFILE_NOT_FOUND");
    const current = this.profiles[index]!;
    if (input.sendConversationId && !current.conversationIds.includes(input.sendConversationId)) {
      throw new AppError("The send override must be one of the merged direct messages", 400, "INVALID_SEND_OVERRIDE");
    }

    const updated: ProfileMerge = {
      ...current,
      ...(input.displayName === undefined ? {} : input.displayName ? { displayName: input.displayName } : { displayName: undefined }),
      ...(input.sendConversationId === undefined
        ? {}
        : input.sendConversationId
          ? { sendConversationId: input.sendConversationId }
          : { sendConversationId: undefined }),
    };
    this.profiles[index] = updated;
    this.save();
    return copyProfile(updated);
  }

  delete(profileId: string): boolean {
    const next = this.profiles.filter(({ id }) => id !== profileId);
    if (next.length === this.profiles.length) return false;
    this.profiles = next;
    this.save();
    return true;
  }

  private load(): ProfileMerge[] {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isProfileMerge).map(copyProfile);
    } catch (error) {
      console.error(`Could not load profile merges from ${this.storagePath}:`, error);
      return [];
    }
  }

  private save(): void {
    if (!this.storagePath) return;
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.profiles, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.storagePath);
  }
}

function copyProfile(profile: ProfileMerge): ProfileMerge {
  return { ...profile, conversationIds: [...profile.conversationIds] };
}

function isProfileMerge(value: unknown): value is ProfileMerge {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ProfileMerge>;
  return typeof profile.id === "string"
    && profile.id.startsWith("profile:")
    && Array.isArray(profile.conversationIds)
    && profile.conversationIds.length >= 2
    && profile.conversationIds.every((id) => typeof id === "string")
    && typeof profile.createdAt === "string"
    && (profile.displayName === undefined || typeof profile.displayName === "string")
    && (profile.sendConversationId === undefined
      || profile.conversationIds.includes(profile.sendConversationId));
}
