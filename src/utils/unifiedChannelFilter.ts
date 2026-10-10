/**
 * `channel` value of `GET /api/unified/messages` that asks for every readable
 * channel at once (#5361). Not a channel name: a real channel called
 * `__all__` cannot be picked in the unified view.
 */
export const ALL_CHANNELS_PARAM = '__all__';
