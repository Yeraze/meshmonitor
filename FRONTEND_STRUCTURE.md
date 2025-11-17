# Frontend Component Structure Summary

## Overview
The MeshMonitor frontend is built as a monolithic React application in `/home/yeraze/Development/meshmonitor/src/App.tsx` (5000+ lines). There are no separate page components - all tabs (channels, messages, etc.) are rendered as different views within the main App component.

---

## 1. CHANNELS PAGE/TAB

### Location
- **Render Function**: `renderChannelsTab()` in `/home/yeraze/Development/meshmonitor/src/App.tsx` (line 3037)
- **Trigger**: Activated when `activeTab === 'channels'` (line 5070)

### Structure

#### A. Channel List (Responsive)
**Mobile View** (line 3058-3090):
- Dropdown select element with class `channel-dropdown-select`
- Shows: encryption icon, channel name, channel number, MQTT status, unread count

**Desktop View** (line 3093-3156):
- Grid of channel buttons with class `channels-grid`
- Each button has class `channel-button` and becomes `.selected` when active
- Button structure:
  ```
  .channel-button
    ├─ .channel-button-content
    │  ├─ .channel-button-left
    │  │  ├─ .channel-button-header
    │  │  │  ├─ .channel-name
    │  │  │  └─ .channel-id
    │  │  └─ .channel-button-indicators
    │  │     ├─ .encryption-icon (🔒 or 🔓)
    │  │     └─ "info" link
    │  └─ .channel-button-right
    │     ├─ .unread-badge (if unread > 0)
    │     └─ .channel-button-status
    │        ├─ .arrow-icon.uplink
    │        └─ .arrow-icon.downlink
  ```

**Key Features**:
- Unread message badges
- Encryption status indicators
- MQTT uplink/downlink status
- Click to select channel
- "Info" link to show channel details modal

#### B. Selected Channel Display (line 3159-3372)
- Shows when `selectedChannel !== -1`
- Displays channel name and ID in header
- Contains: messages container + send form

#### C. Messages Container (line 3167-3308)
- Class: `messages-container` with ref `channelMessagesContainerRef`
- Features:
  - Messages filtered by selected channel ID
  - MQTT messages can be toggled on/off
  - Traceroutes filtered from Primary channel (channel 0)
  - Messages sorted by timestamp (oldest first)
  - Date separators between days

#### D. Message Display Format (line 3189-3303)
Each message renders as:
```
.date-separator (if needed)
  └─ .date-separator-text

.message-bubble-container (mine | theirs)
  ├─ .sender-dot (if not mine) - shows node short name
  ├─ .message-content
  │  ├─ .replied-message (if replying to another)
  │  │  ├─ .reply-arrow (↳)
  │  │  └─ .reply-content
  │  └─ .message-bubble (mine | theirs)
  │     ├─ .message-actions (appears on hover)
  │     │  ├─ .reply-button (↩)
  │     │  └─ .emoji-picker-button (😄)
  │     ├─ .message-text
  │     ├─ .message-reactions (if any)
  │     │  └─ .reaction (clickable)
  │     └─ .message-meta
  │        └─ .message-time
  └─ .message-status (if mine) - delivery status
```

#### E. Send Message Form (line 3312-3359)
- Shows when `connectionStatus === 'connected'`
- Permission check: `hasPermission('channels', 'write')`
- Features:
  - Reply indicator (if replying to a message)
  - Message input with character counter
  - Send button (→)
  - Byte count display
  - Max width for visibility

#### F. Channel Info Modal (line 3376-3472)
- Triggered by "info" link on channel button
- Shows:
  - Channel name
  - Channel number
  - Encryption status (encrypted/unencrypted)
  - PSK (with show/hide toggle)
  - MQTT uplink/downlink status
  - Created and updated timestamps

#### G. Header Controls (line 3041-3053)
- Channel count display
- "Show MQTT/Bridge Messages" toggle
- Affects message filtering across all channels

---

## 2. MESSAGES PAGE/TAB (Direct Messages)

### Location
- **Render Function**: `renderMessagesTab()` in `/home/yeraze/Development/meshmonitor/src/App.tsx` (line 3477)
- **Trigger**: Activated when `activeTab === 'messages'` (line 5071)

### Structure

#### A. Node List (line 3479-3550)
- Shows nodes that have direct message conversations
- Uses `processedNodes` (already sorted from Map page)
- Each node entry shows:
  - Node name/callsign
  - Message count (total messages with this node)
  - Unread count (from database-backed tracking)
  - Last message time
  - Last message text (truncated)
  - Device role/type

#### B. Selected DM Conversation (line 3550-4069)
- Similar structure to channels
- Contains: messages container + send form
- Key differences from channels:
  - Only shows messages with selected node
  - Uses `dmMessages` instead of `channelMessages`
  - Permission check: `hasPermission('messages', 'write')`

#### C. Message Display (line 3930-4024)
- Same format as channel messages
- Renders with same hover actions (reply, emoji react)
- Shows delivery status for sent messages

#### D. Send DM Form (line 4027-4069)
- Similar to channel send form
- Permission check: `hasPermission('messages', 'write')`
- Input ref: `dmMessageInputRef`

---

## 3. EXISTING MESSAGE HOVER/ACTION MENUS

### Location in App.tsx
- **Channels**: Line 3250-3270
- **Direct Messages**: Line 3966-3986

### HTML Structure
```
.message-actions (initially opacity: 0)
  ├─ .reply-button
  │  └─ ↩ (reply arrow icon)
  └─ .emoji-picker-button
     └─ 😄 (smile emoji)
```

### CSS Styling
**File**: `/home/yeraze/Development/meshmonitor/src/App.css`
- `.message-actions`: Lines 2141-2152
- `.message-bubble-container:hover .message-actions`: Line 2154 (opacity: 1)
- `.reply-button, .emoji-picker-button`: Lines 2158-2168
- Hover states: Line 2181-2185
- Active states: Line 2187-2189

### Features
1. **Reply Button** (↩)
   - Sets `replyingTo` state to the message
   - Focuses input field
   - Shows reply indicator above message input

2. **Emoji Picker Button** (😄)
   - Opens modal with emoji grid
   - Available emojis defined in component state
   - On selection: sends emoji as reaction/tapback
   - Reactions appear inline under original message

### Hover Behavior
- Actions appear only on hover (opacity transition 0.2s)
- Scale animation on hover (1.1x)
- Scale animation on active (0.95x)
- Positioned absolutely in top-right of message bubble

### Emoji Picker Modal
**CSS**: Lines 2192-2289
- Modal styling: `.emoji-picker-modal`
- Header with close button: `.emoji-picker-header` + `.emoji-picker-close`
- Grid layout: `.emoji-picker-grid` with responsive columns
- Items: `.emoji-picker-item` with hover effects
- Mobile optimizations: Media query at line 2268

---

## 4. PERMISSION CHECKING LOGIC

### Type Definitions
**File**: `/home/yeraze/Development/meshmonitor/src/types/permission.ts`

#### ResourceType (lines 5-18)
```typescript
'dashboard' | 'nodes' | 'channels' | 'messages' | 'settings' | 
'configuration' | 'info' | 'automation' | 'connection' | 'traceroute' | 
'audit' | 'security' | 'themes'
```

#### PermissionAction (line 20)
```typescript
'read' | 'write'
```

#### Permission Interface (lines 22-30)
```typescript
interface Permission {
  id: number;
  userId: number;
  resource: ResourceType;
  canRead: boolean;
  canWrite: boolean;
  grantedAt: number;
  grantedBy: number | null;
}
```

### Default Permissions
**File**: `/home/yeraze/Development/meshmonitor/src/types/permission.ts` (lines 69-100)

#### ADMIN_PERMISSIONS
- All resources: `{ read: true, write: true }`

#### DEFAULT_USER_PERMISSIONS
```typescript
{
  dashboard: { read: true, write: false },
  nodes: { read: true, write: false },
  channels: { read: true, write: false },    // Can read but not write
  messages: { read: true, write: false },    // Can read but not write
  settings: { read: false, write: false },
  configuration: { read: false, write: false },
  info: { read: true, write: false },
  automation: { read: false, write: false },
  connection: { read: true, write: false },
  traceroute: { read: true, write: false },
  audit: { read: false, write: false },
  security: { read: false, write: false },
  themes: { read: true, write: false }
}
```

### useAuth Hook (hasPermission Function)
**File**: `/home/yeraze/Development/meshmonitor/src/contexts/AuthContext.tsx` (lines 140-158)

```typescript
const hasPermission = useCallback(
  (resource: keyof PermissionSet, action: 'read' | 'write'): boolean => {
    // If authenticated and admin, grant all permissions
    if (authStatus?.authenticated && authStatus.user?.isAdmin) {
      return true;
    }

    // Check permissions (works for both authenticated and anonymous users)
    if (!authStatus) {
      return false;
    }

    const resourcePermissions = authStatus.permissions[resource];
    if (!resourcePermissions) {
      return false;
    }

    return resourcePermissions[action] === true;
  },
  [authStatus]
);
```

### Usage in Frontend
**Channels Write Permission**: Line 3250 & 3329
```typescript
{hasPermission('channels', 'write') && (
  <div className="message-actions">
    {/* reply and emoji buttons */}
  </div>
)}
```

**Messages Write Permission**: Line 3966 & 4045
```typescript
{hasPermission('messages', 'write') && (
  <div className="message-actions">
    {/* reply and emoji buttons */}
  </div>
)}
```

**Send Button**: Line 3329 (channels) and 4045 (messages)
```typescript
{hasPermission('channels', 'write') && (
  <div className="message-input-container">
    {/* input and send button */}
  </div>
)}
```

### AuthStatus Interface
**File**: `/home/yeraze/Development/meshmonitor/src/contexts/AuthContext.tsx` (lines 25-32)

```typescript
interface AuthStatus {
  authenticated: boolean;
  user: User | null;
  permissions: PermissionSet;  // User's permissions
  oidcEnabled: boolean;
  localAuthDisabled: boolean;
  anonymousDisabled: boolean;
}
```

---

## 5. KEY FILES AND LINE REFERENCES

### App.tsx
- Main component: `/home/yeraze/Development/meshmonitor/src/App.tsx`
- `renderChannelsTab()`: Line 3037
- `renderMessagesTab()`: Line 3477
- Message rendering (channels): Line 3189-3303
- Message rendering (DMs): Line 3915-4024
- Message actions (channels): Line 3250-3270
- Message actions (DMs): Line 3966-3986
- Send form (channels): Line 3312-3359
- Send form (DMs): Line 4027-4069
- useAuth hook usage: Line 123

### App.css
- Message bubble container: Line 2036-2051
- Message bubble styling: Line 2094-2126
- Message actions: Line 2141-2156
- Emoji picker: Line 2192-2289
- Reply indicator: Line 2291-2331

### Permission Types
- `/home/yeraze/Development/meshmonitor/src/types/permission.ts`
  - ResourceType: Lines 5-18
  - Permission interface: Lines 22-30
  - Default permissions: Lines 69-100

### Auth Context
- `/home/yeraze/Development/meshmonitor/src/contexts/AuthContext.tsx`
  - AuthStatus interface: Lines 25-32
  - hasPermission function: Lines 140-158
  - useAuth hook: Lines 177-183

---

## 6. STATE MANAGEMENT FOR MESSAGES

### Key State Variables in App.tsx
- `selectedChannel`: Currently selected channel ID
- `newMessage`: Text being typed in channel message input
- `replyingTo`: Message being replied to (null or message object)
- `channelMessages`: Dictionary of channel ID → messages array
- `messages`: Direct messages array (deprecated - use channelMessages)
- `dmMessages`: Direct messages (accessed via getDMMessages function)
- `emojiPickerMessage`: Message selected for emoji reaction
- `unreadCounts`: Dictionary of channel/node ID → unread count
- `showMqttMessages`: Boolean to show/hide MQTT bridge messages

### Context Providers
- `AuthContext`: Authentication and permissions
- `MessagingContext`: Message-related state
- `DataContext`: Node and channel data
- `UIContext`: UI state (modal visibility, etc.)

---

## Summary Table

| Component | Location | Permission Check | Styling Class |
|-----------|----------|------------------|----------------|
| Channel List | Line 3093-3156 | N/A | `.channels-grid`, `.channel-button` |
| Channel Messages | Line 3167-3308 | read: implicit | `.messages-container` |
| Channel Send Form | Line 3312-3359 | `hasPermission('channels', 'write')` | `.message-input-container` |
| DM Node List | Line 3540-3550 | N/A | Dynamic list |
| DM Messages | Line 3925-4024 | read: implicit | `.messages-container` |
| DM Send Form | Line 4027-4069 | `hasPermission('messages', 'write')` | `.message-input-container` |
| Message Actions | Line 3250/3966 | `hasPermission('channels\|messages', 'write')` | `.message-actions` |
| Reply Button | Line 3253/3969 | Inherited | `.reply-button` |
| Emoji Picker | Line 3263/3979 | Inherited | `.emoji-picker-button` |
