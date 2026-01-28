/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GeofenceTriggersSection from './GeofenceTriggersSection';
import { GeofenceTrigger } from './auto-responder/types.js';
import { Channel } from '../types/device.js';

// Mock the useCsrfFetch hook
const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

// Mock the ToastContainer
const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

// Mock the useSaveBar hook
const mockUseSaveBar = vi.fn();
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (args: unknown) => mockUseSaveBar(args),
}));

// Mock GeofenceMapEditor as a simple div stub
vi.mock('./GeofenceMapEditor', () => ({
  default: (props: { onShapeChange: (shape: unknown) => void }) => (
    <div data-testid="geofence-map-editor">
      <button
        data-testid="set-circle-shape"
        onClick={() =>
          props.onShapeChange({ type: 'circle', center: { lat: 40.0, lng: -74.0 }, radiusKm: 3 })
        }
      >
        Set Circle Shape
      </button>
    </div>
  ),
}));

// Mock GeofenceNodeSelector as a simple div stub
vi.mock('./GeofenceNodeSelector', () => ({
  default: () => <div data-testid="geofence-node-selector">Node Selector</div>,
}));

// Mock fetch for scripts API call
global.fetch = vi.fn();

const sampleTrigger: GeofenceTrigger = {
  id: 'test-1',
  name: 'Test Geofence',
  enabled: true,
  shape: { type: 'circle', center: { lat: 40.7128, lng: -74.006 }, radiusKm: 5 },
  event: 'entry',
  nodeFilter: { type: 'all' },
  responseType: 'text',
  response: 'Node entered zone',
  channel: 0,
};

const mockChannels: Channel[] = [
  { id: 0, name: 'Primary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
  { id: 1, name: 'Secondary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
];

const mockNodes = [
  { nodeNum: 1, longName: 'Node One', shortName: 'N1', latitude: 40.7128, longitude: -74.006 },
  { nodeNum: 2, longName: 'Node Two', shortName: 'N2', latitude: 41.0, longitude: -73.0 },
];

const defaultProps = {
  triggers: [] as GeofenceTrigger[],
  channels: mockChannels,
  nodes: mockNodes,
  baseUrl: '',
  onTriggersChange: vi.fn(),
};

describe('GeofenceTriggersSection Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ scripts: [] }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Section header and description', () => {
    it('should render the section header and description', () => {
      render(<GeofenceTriggersSection {...defaultProps} />);

      expect(screen.getByText('automation.geofence_triggers.section_title')).toBeInTheDocument();
      expect(screen.getByText('automation.geofence_triggers.description')).toBeInTheDocument();
    });
  });

  describe('Empty state', () => {
    it('should show "no triggers" message when triggers array is empty', () => {
      render(<GeofenceTriggersSection {...defaultProps} triggers={[]} />);

      expect(screen.getByText('automation.geofence_triggers.no_triggers')).toBeInTheDocument();
    });
  });

  describe('Existing triggers list', () => {
    it('should render existing triggers with correct name, shape info, and event type', () => {
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Trigger name
      expect(screen.getByText('Test Geofence')).toBeInTheDocument();

      // Shape info: Circle (5.0 km) and event label combined in the trigger detail line
      expect(screen.getByText(/Circle \(5\.0 km\)/)).toBeInTheDocument();
      // The event label appears both in the trigger item and in the add form's select,
      // so verify at least one instance is present
      expect(screen.getAllByText(/automation\.geofence_triggers\.event_entry/).length).toBeGreaterThanOrEqual(1);

      // Should show the existing triggers heading with count
      expect(screen.getByText(/automation\.geofence_triggers\.existing/)).toBeInTheDocument();
    });

    it('should render a polygon trigger with vertex count', () => {
      const polygonTrigger: GeofenceTrigger = {
        ...sampleTrigger,
        id: 'test-poly',
        name: 'Polygon Zone',
        shape: {
          type: 'polygon',
          vertices: [
            { lat: 40.0, lng: -74.0 },
            { lat: 41.0, lng: -74.0 },
            { lat: 41.0, lng: -73.0 },
          ],
        },
      };
      render(<GeofenceTriggersSection {...defaultProps} triggers={[polygonTrigger]} />);

      expect(screen.getByText('Polygon Zone')).toBeInTheDocument();
      expect(screen.getByText(/Polygon \(3 vertices\)/)).toBeInTheDocument();
    });

    it('should not show the "no triggers" message when triggers exist', () => {
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      expect(screen.queryByText('automation.geofence_triggers.no_triggers')).not.toBeInTheDocument();
    });
  });

  describe('Toggle enable/disable', () => {
    it('should toggle a trigger enabled state when clicking the toggle button', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Initially enabled
      expect(screen.getByText('ENABLED')).toBeInTheDocument();

      // Click the Disable button
      const disableButton = screen.getByText('Disable');
      await user.click(disableButton);

      // After toggle, should show DISABLED
      expect(screen.getByText('DISABLED')).toBeInTheDocument();
      expect(screen.getByText('Enable')).toBeInTheDocument();
    });

    it('should toggle a disabled trigger back to enabled', async () => {
      const user = userEvent.setup({ delay: null });
      const disabledTrigger: GeofenceTrigger = { ...sampleTrigger, enabled: false };
      render(<GeofenceTriggersSection {...defaultProps} triggers={[disabledTrigger]} />);

      expect(screen.getByText('DISABLED')).toBeInTheDocument();

      const enableButton = screen.getByText('Enable');
      await user.click(enableButton);

      expect(screen.getByText('ENABLED')).toBeInTheDocument();
    });
  });

  describe('Remove trigger with confirmation modal', () => {
    it('should show confirmation modal when Remove is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      const removeButton = screen.getByText('Remove');
      await user.click(removeButton);

      // Modal should appear with the trigger name
      expect(screen.getByText('Remove Geofence Trigger')).toBeInTheDocument();
      expect(screen.getByText(/Are you sure you want to remove "Test Geofence"\?/)).toBeInTheDocument();
    });

    it('should cancel the removal when Cancel is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Open the modal
      await user.click(screen.getByText('Remove'));
      expect(screen.getByText('Remove Geofence Trigger')).toBeInTheDocument();

      // Click Cancel
      await user.click(screen.getByText('Cancel'));

      // Trigger should still be present
      expect(screen.getByText('Test Geofence')).toBeInTheDocument();
    });

    it('should remove the trigger when confirming removal', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Open the modal
      await user.click(screen.getByText('Remove'));

      // Find and click the confirm Remove button inside the modal
      const modal = screen.getByText('Remove Geofence Trigger').closest('div')!.parentElement!;
      const confirmButtons = within(modal).getAllByText('Remove');
      // The last Remove button in the modal is the confirm button
      await user.click(confirmButtons[confirmButtons.length - 1]);

      // Trigger should be gone, "no triggers" message should appear
      expect(screen.queryByText('Test Geofence')).not.toBeInTheDocument();
      expect(screen.getByText('automation.geofence_triggers.no_triggers')).toBeInTheDocument();
    });
  });

  describe('Add trigger form', () => {
    it('should fill in name, select shape type, event type, and response type', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} />);

      // Fill in the name
      const nameInput = screen.getByPlaceholderText('automation.geofence_triggers.name_placeholder');
      await user.type(nameInput, 'My New Geofence');

      // Shape type defaults to circle (radio button should be checked)
      const circleRadio = screen.getByDisplayValue('circle');
      expect(circleRadio).toBeChecked();

      // Select polygon shape type
      const polygonRadio = screen.getByDisplayValue('polygon');
      await user.click(polygonRadio);
      expect(polygonRadio).toBeChecked();

      // Select event type
      const eventSelect = screen.getByDisplayValue('automation.geofence_triggers.event_entry');
      await user.selectOptions(eventSelect, 'exit');

      // Response type defaults to text
      const textRadio = screen.getByDisplayValue('text') as HTMLInputElement;
      expect(textRadio.checked).toBe(true);
    });

    it('should add a trigger successfully when all fields are filled', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} />);

      // Fill in name
      const nameInput = screen.getByPlaceholderText('automation.geofence_triggers.name_placeholder');
      await user.type(nameInput, 'New Zone');

      // Set shape via the mocked map editor
      const setShapeButton = screen.getByTestId('set-circle-shape');
      await user.click(setShapeButton);

      // Fill in the text response message
      const messageInput = screen.getByPlaceholderText('automation.geofence_triggers.message_placeholder');
      await user.type(messageInput, 'Alert: node entered zone');

      // Click Add button
      const addButton = screen.getByText('automation.geofence_triggers.add');
      await user.click(addButton);

      // Should show success toast
      expect(mockShowToast).toHaveBeenCalledWith('automation.geofence_triggers.added', 'success');

      // The new trigger should appear in the list
      expect(screen.getByText('New Zone')).toBeInTheDocument();
    });
  });

  describe('Add trigger validation', () => {
    it('should disable add button when name is empty', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} />);

      // Set shape so that's not the problem
      const setShapeButton = screen.getByTestId('set-circle-shape');
      await user.click(setShapeButton);

      // Fill in a message but leave name empty
      const messageInput = screen.getByPlaceholderText('automation.geofence_triggers.message_placeholder');
      await user.type(messageInput, 'Some message');

      // Add button should be disabled when name is empty
      const addButton = screen.getByText('automation.geofence_triggers.add');
      expect(addButton).toBeDisabled();

      // No toast should have been called
      expect(mockShowToast).not.toHaveBeenCalled();
    });

    it('should disable add button when no shape is defined', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} />);

      // Fill in name
      const nameInput = screen.getByPlaceholderText('automation.geofence_triggers.name_placeholder');
      await user.type(nameInput, 'Test Zone');

      // Fill in a message
      const messageInput = screen.getByPlaceholderText('automation.geofence_triggers.message_placeholder');
      await user.type(messageInput, 'Some message');

      // Do NOT set shape -- add button should be disabled
      const addButton = screen.getByText('automation.geofence_triggers.add');
      expect(addButton).toBeDisabled();

      // No toast should have been called
      expect(mockShowToast).not.toHaveBeenCalled();
    });
  });

  describe('Edit trigger', () => {
    it('should show Edit button on existing triggers', () => {
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      const editButton = screen.getByText('Edit');
      expect(editButton).toBeInTheDocument();
    });

    it('should populate form with trigger data when Edit is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Click the Edit button
      const editButton = screen.getByText('Edit');
      await user.click(editButton);

      // Check that the name field is populated
      const nameInput = screen.getByPlaceholderText('automation.geofence_triggers.name_placeholder') as HTMLInputElement;
      expect(nameInput.value).toBe('Test Geofence');

      // Check that the response field is populated
      const messageInput = screen.getByPlaceholderText('automation.geofence_triggers.message_placeholder') as HTMLTextAreaElement;
      expect(messageInput.value).toBe('Node entered zone');
    });

    it('should show edit header and Save button when editing', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Click the Edit button
      const editButton = screen.getByText('Edit');
      await user.click(editButton);

      // Should show edit header
      expect(screen.getByText('automation.geofence_triggers.edit_trigger')).toBeInTheDocument();

      // Should show Save Changes button instead of Add
      expect(screen.getByText('automation.geofence_triggers.save')).toBeInTheDocument();
      expect(screen.queryByText('automation.geofence_triggers.add')).not.toBeInTheDocument();
    });

    it('should show Cancel button when editing', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Click the Edit button
      const editButton = screen.getByText('Edit');
      await user.click(editButton);

      // Cancel button should appear
      expect(screen.getByText('common.cancel')).toBeInTheDocument();
    });

    it('should cancel editing and reset form when Cancel is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Click the Edit button
      const editButton = screen.getByText('Edit');
      await user.click(editButton);

      // Verify we're in edit mode
      expect(screen.getByText('automation.geofence_triggers.edit_trigger')).toBeInTheDocument();

      // Click Cancel
      const cancelButton = screen.getByText('common.cancel');
      await user.click(cancelButton);

      // Should exit edit mode - show Add header again
      expect(screen.getByText('automation.geofence_triggers.add_new')).toBeInTheDocument();
      expect(screen.queryByText('automation.geofence_triggers.edit_trigger')).not.toBeInTheDocument();

      // Name field should be empty
      const nameInput = screen.getByPlaceholderText('automation.geofence_triggers.name_placeholder') as HTMLInputElement;
      expect(nameInput.value).toBe('');
    });

    it('should update trigger when saving changes', async () => {
      const user = userEvent.setup({ delay: null });
      render(<GeofenceTriggersSection {...defaultProps} triggers={[sampleTrigger]} />);

      // Click the Edit button
      const editButton = screen.getByText('Edit');
      await user.click(editButton);

      // Change the name
      const nameInput = screen.getByPlaceholderText('automation.geofence_triggers.name_placeholder');
      await user.clear(nameInput);
      await user.type(nameInput, 'Updated Geofence Name');

      // Click Save
      const saveButton = screen.getByText('automation.geofence_triggers.save');
      await user.click(saveButton);

      // Should show success toast
      expect(mockShowToast).toHaveBeenCalledWith('automation.geofence_triggers.updated', 'success');

      // The updated trigger name should appear in the list
      expect(screen.getByText('Updated Geofence Name')).toBeInTheDocument();

      // The old name should not be present
      expect(screen.queryByText('Test Geofence')).not.toBeInTheDocument();
    });
  });
});
