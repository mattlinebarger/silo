// Profile manager for handling multiple Google account profiles
// Uses electron-store for persistent storage of profile data

// Profile data structure:
// {
//   id: string (UUID)
//   name: string (user-provided)
//   avatarPath: string (path to custom profile picture, optional)
//   createdAt: number (timestamp)
//   isDefault: boolean (true for non-partitioned session)
// }

class ProfileManager {
  constructor(Store) {
    this.store = new Store({
      name: "profiles",
      defaults: {
        profiles: [
          {
            id: "default",
            name: "Default Profile",
            avatarPath: null,
            createdAt: Date.now(),
            isDefault: true,
          },
        ],
        activeProfileId: "default",
      },
    });
  }

  // Get all profiles
  getProfiles() {
    return this.store.get("profiles");
  }

  // Get active profile
  getActiveProfile() {
    const activeId = this.store.get("activeProfileId");
    return this.getProfiles().find((p) => p.id === activeId);
  }

  // Get profile by ID
  getProfile(id) {
    return this.getProfiles().find((p) => p.id === id);
  }

  // Create new profile
  createProfile({ name, avatarPath = null }) {
    const profiles = this.getProfiles();
    const newProfile = {
      id: this._generateId(),
      name,
      avatarPath,
      createdAt: Date.now(),
      isDefault: false,
    };

    profiles.push(newProfile);
    this.store.set("profiles", profiles);

    return newProfile;
  }

  // Update profile
  updateProfile(id, updates) {
    const profiles = this.getProfiles();
    const index = profiles.findIndex((p) => p.id === id);

    if (index === -1) {
      throw new Error(`Profile with id ${id} not found`);
    }

    // Don't allow changing isDefault flag
    const { isDefault, id: _, ...allowedUpdates } = updates;

    profiles[index] = {
      ...profiles[index],
      ...allowedUpdates,
    };

    this.store.set("profiles", profiles);
    return profiles[index];
  }

  // Delete profile (cannot delete default)
  deleteProfile(id) {
    if (id === "default") {
      throw new Error("Cannot delete default profile");
    }

    const profiles = this.getProfiles();
    const filtered = profiles.filter((p) => p.id !== id);

    if (filtered.length === profiles.length) {
      throw new Error(`Profile with id ${id} not found`);
    }

    this.store.set("profiles", filtered);

    // If deleted profile was active, switch to default
    if (this.store.get("activeProfileId") === id) {
      const defaultProfile = filtered.find(p => p.id === "default");
      if (defaultProfile) {
        this.store.set("activeProfileId", "default");
      } else if (filtered.length > 0) {
        // If somehow default doesn't exist, use first available profile
        this.store.set("activeProfileId", filtered[0].id);
      }
    }

    return true;
  }

  // Set active profile
  setActiveProfile(id) {
    const profile = this.getProfile(id);
    if (!profile) {
      throw new Error(`Profile with id ${id} not found`);
    }

    this.store.set("activeProfileId", id);
    return profile;
  }

  // Get session partition name for a profile
  getPartitionName(profileId) {
    const profile = this.getProfile(profileId);
    if (!profile) {
      throw new Error(`Profile with id ${profileId} not found`);
    }

    // Default profile uses no partition (default session)
    if (profile.isDefault) {
      return null;
    }

    // Other profiles use persistent partitions
    return `persist:profile-${profileId}`;
  }

  // Generate unique ID
  _generateId() {
    return `profile-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = ProfileManager;
