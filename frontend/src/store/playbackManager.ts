/**
 * This store handles the state of the playback
 *
 * It must be used in an agnostic way to cover both local and remote playback.
 * If you want to handle the state of the local player element, use playerElement store instead.
 */
import { reactive, watch, watchEffect } from 'vue';
import { shuffle, isNil } from 'lodash-es';
import { v4 } from 'uuid';
import {
  BaseItemDto,
  ItemFields,
  ItemFilter,
  MediaSourceInfo,
  SubtitleDeliveryMethod,
  MediaStream,
  BaseItemKind,
  PlaybackInfoResponse,
  MediaStreamType
} from '@jellyfin/sdk/lib/generated-client';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import { getInstantMixApi } from '@jellyfin/sdk/lib/utils/api/instant-mix-api';
import { getTvShowsApi } from '@jellyfin/sdk/lib/utils/api/tv-shows-api';
import { getPlaystateApi } from '@jellyfin/sdk/lib/utils/api/playstate-api';
import { getMediaInfoApi } from '@jellyfin/sdk/lib/utils/api/media-info-api';
import { useEventListener } from '@vueuse/core';
/**
 * It's important to import these from globals.ts directly to avoid cycles and ReferenceError
 */
import { now as reactiveDate, mediaControls } from './globals';
import { itemsStore } from '.';
import { usei18n, useRemote, useSnackbar } from '@/composables';
import { getImageInfo } from '@/utils/images';
import { msToTicks } from '@/utils/time';
import playbackProfile from '@/utils/playback-profiles';
import { getItemRuntime } from '@/utils/items';

/**
 * == INTERFACES AND TYPES ==
 */

export enum PlaybackStatus {
  Stopped = 0,
  Playing = 1,
  Paused = 2,
  Buffering = 3,
  Error = 4
}

export enum RepeatMode {
  RepeatNone = 0,
  RepeatOne = 1,
  RepeatAll = 2
}

export enum InitMode {
  Unknown = 0,
  Shuffle = 1,
  Item = 2,
  ShuffleItem = 3
}

export interface PlaybackTrack {
  label: string;
  src?: string;
  srcLang?: string;
  srcIndex: number;
  type: SubtitleDeliveryMethod;
  codec?: string;
}

export interface PlaybackExternalTrack extends PlaybackTrack {
  src: string;
  codec: string;
}

interface PlaybackManagerState {
  status: PlaybackStatus;
  currentSourceUrl: string | undefined;
  currentItemIndex: number | undefined;
  currentMediaSource: MediaSourceInfo | undefined;
  currentMediaSourceIndex: number | undefined;
  currentVideoStreamIndex: number | undefined;
  currentAudioStreamIndex: number | undefined;
  currentSubtitleStreamIndex: number | undefined;
  remotePlaybackTime: number;
  lastProgressUpdate: number;
  remoteCurrentVolume: number;
  isRemotePlayer: boolean;
  isRemoteMuted: boolean;
  isShuffling: boolean;
  repeatMode: RepeatMode;
  queue: string[];
  originalQueue: string[];
  playSessionId: string | undefined;
  playbackInitiator: BaseItemDto | undefined;
  playbackInitMode: InitMode;
}

/**
 * == UTILITY VARIABLES ==
 */
/**
 * Amount of time to wait between playback reports
 */
const progressReportInterval = 3500;
const remote = useRemote();

/**
 * == CLASS CONSTRUCTOR ==
 */
class PlaybackManagerStore {
  /**
   * == STATE ==
   */
  /**
   * Reactive state
   */
  private _defaultState: PlaybackManagerState = {
    status: PlaybackStatus.Stopped,
    currentSourceUrl: undefined,
    currentItemIndex: undefined,
    currentMediaSource: undefined,
    currentMediaSourceIndex: undefined,
    currentVideoStreamIndex: undefined,
    currentAudioStreamIndex: undefined,
    currentSubtitleStreamIndex: undefined,
    remotePlaybackTime: 0,
    lastProgressUpdate: 0,
    remoteCurrentVolume: 100,
    isRemotePlayer: false,
    isRemoteMuted: false,
    isShuffling: false,
    repeatMode: RepeatMode.RepeatNone,
    queue: [],
    originalQueue: [],
    playSessionId: undefined,
    playbackInitiator: undefined,
    playbackInitMode: InitMode.Unknown
  };

  private _state = reactive<PlaybackManagerState>(
    structuredClone(this._defaultState)
  );
  /**
   * Non-reactive state
   */
  private _isProgressUpdating = false;
  private _mediaSourceRequestId: string | undefined = undefined;
  /**
   * == GETTERS AND SETTERS ==
   */
  public get status(): PlaybackStatus {
    return this._state.status;
  }
  /**
   * Get if playback is buffering
   */
  public get isBuffering(): boolean {
    return this.status === PlaybackStatus.Buffering;
  }
  /**
   * Get if an item is being played at this moment
   */
  public get isPlaying(): boolean {
    return this.status !== PlaybackStatus.Stopped;
  }
  /**
   * Get if the repeat status is not set to none
   */
  public get isRepeating(): boolean {
    return this._state.repeatMode !== RepeatMode.RepeatNone;
  }
  /**
   * Get if the queue is being repeated
   */
  public get isRepeatingAll(): boolean {
    return this._state.repeatMode === RepeatMode.RepeatAll;
  }
  /**
   * Get if an item is being repeated
   */
  public get isRepeatingOnce(): boolean {
    return this._state.repeatMode === RepeatMode.RepeatOne;
  }
  /**
   * Get if an item is paused at this moment
   */
  public get isPaused(): boolean {
    return this.status === PlaybackStatus.Paused;
  }
  /**
   * Get if the current playback session is remote or local
   */
  public get isRemotePlayer(): boolean {
    return this._state.isRemotePlayer;
  }
  /**
   * Get reactive BaseItemDto's objects of the queue
   */
  public get queue(): BaseItemDto[] {
    if (this._state.queue.length > 0) {
      const items = itemsStore();

      return items.getItemsById(this._state.queue);
    }

    return [];
  }
  /**
   * Get a reactive BaseItemDto object of the currently playing item
   */
  public get currentItem(): BaseItemDto | undefined {
    if (!isNil(this._state.currentItemIndex)) {
      const items = itemsStore();

      return items.getItemById(this._state.queue[this._state.currentItemIndex]);
    }
  }
  public get currentSourceUrl(): string | undefined {
    return this._state.currentSourceUrl;
  }
  /**
   * Get a reactive BaseItemDto object of the next item in queue
   */
  public get nextItem(): BaseItemDto | undefined {
    const items = itemsStore();

    if (
      !isNil(this._state.currentItemIndex) &&
      this._state.currentItemIndex + 1 < this._state.queue.length
    ) {
      return items.getItemById(
        this._state.queue[this._state.currentItemIndex + 1]
      );
    } else if (this._state.repeatMode === RepeatMode.RepeatAll) {
      return items.getItemById(this._state.queue[0]);
    }
  }
  /**
   * Get the type of the currently playing item
   */
  public get currentlyPlayingType(): BaseItemKind | undefined {
    if (!isNil(this._state.currentItemIndex)) {
      const items = itemsStore();

      return items.getItemById(this._state.queue[this._state.currentItemIndex])
        ?.Type;
    }
  }
  /**
   * Get the media type of the currently playing item
   */
  public get currentlyPlayingMediaType(): string | null | undefined {
    if (!isNil(this._state.currentItemIndex)) {
      const items = itemsStore();

      return items.getItemById(this._state.queue[this._state.currentItemIndex])
        ?.MediaType;
    }
  }
  /**
   * Get current's item audio tracks
   */
  public get currentItemAudioTracks(): MediaStream[] | undefined {
    if (!isNil(this._state.currentMediaSource?.MediaStreams)) {
      return this._state.currentMediaSource?.MediaStreams.filter((stream) => {
        return stream.Type === 'Audio';
      });
    }
  }
  /**
   * Get current's item subtitle tracks
   */
  public get currentItemSubtitleTracks(): MediaStream[] | undefined {
    if (!isNil(this._state.currentMediaSource?.MediaStreams)) {
      return this._state.currentMediaSource?.MediaStreams.filter((stream) => {
        return stream.Type === 'Subtitle';
      });
    }
  }

  public get currentItemParsedSubtitleTracks(): PlaybackTrack[] | undefined {
    if (!isNil(this._state.currentMediaSource)) {
      return this._state.currentMediaSource.MediaStreams?.map(
        (stream, index) => ({
          srcIndex: index,
          ...stream
        })
      )
        .filter(
          (sub) =>
            sub.Type === MediaStreamType.Subtitle &&
            (sub.DeliveryMethod === SubtitleDeliveryMethod.Encode ||
              sub.DeliveryMethod === SubtitleDeliveryMethod.External)
        )
        .map((sub) => ({
          label: sub.DisplayTitle ?? 'Undefined',
          src:
            sub.DeliveryMethod === SubtitleDeliveryMethod.External
              ? `${remote.sdk.api?.basePath}${sub.DeliveryUrl}`
              : undefined,
          srcLang: sub.Language ?? undefined,
          type: sub.DeliveryMethod ?? SubtitleDeliveryMethod.Drop,
          srcIndex: sub.srcIndex,
          codec: sub.Codec || undefined
        }));
    }
  }

  /**
   * Filters the native subtitles
   *
   * As our profile requires either SSA or VTT, if it's not SSA it'll be VTT.
   * This is done this way as server sends as "Codec" the initial value of the track, so it can be webvtt, subrip, srt...
   * This is easier to filter out the SSA subs
   */
  public get currentItemVttParsedSubtitleTracks(): PlaybackExternalTrack[] {
    return (
      this.currentItemParsedSubtitleTracks?.filter(
        (sub): sub is PlaybackExternalTrack =>
          !!sub.codec && sub.codec !== 'ass' && sub.codec !== 'ssa' && !!sub.src
      ) ?? []
    );
  }

  public get currentItemAssParsedSubtitleTracks(): PlaybackExternalTrack[] {
    return (
      this.currentItemParsedSubtitleTracks?.filter(
        (sub): sub is PlaybackExternalTrack =>
          !!sub.codec &&
          (sub.codec === 'ass' || sub.codec === 'ssa') &&
          !!sub.src
      ) ?? []
    );
  }

  public get currentVideoTrack(): MediaStream | undefined {
    if (
      !isNil(this._state.currentMediaSource?.MediaStreams) &&
      !isNil(this._state.currentVideoStreamIndex)
    ) {
      return this._state.currentMediaSource?.MediaStreams.find(
        (stream) =>
          stream.Type === 'Video' &&
          stream.Index === this._state.currentVideoStreamIndex
      );
    }
  }

  public get currentAudioTrack(): MediaStream | undefined {
    if (
      !isNil(this._state.currentMediaSource?.MediaStreams) &&
      !isNil(this._state.currentAudioStreamIndex)
    ) {
      return this._state.currentMediaSource?.MediaStreams.find(
        (stream) =>
          stream.Type === 'Audio' &&
          stream.Index === this._state.currentAudioStreamIndex
      );
    }
  }

  public get currentSubtitleTrack(): MediaStream | undefined {
    if (
      !isNil(this._state.currentMediaSource?.MediaStreams) &&
      !isNil(this._state.currentSubtitleStreamIndex)
    ) {
      return this._state.currentMediaSource?.MediaStreams.find(
        (stream) =>
          stream.Type === 'Subtitle' &&
          stream.Index === this._state.currentSubtitleStreamIndex
      );
    }
  }

  public get currentSubtitleStreamIndex(): number | undefined {
    return this._state.currentSubtitleStreamIndex;
  }
  public set currentSubtitleStreamIndex(newIndex: number | undefined) {
    this._state.currentSubtitleStreamIndex = newIndex;
  }

  public get currentAudioStreamIndex(): number | undefined {
    return this._state.currentAudioStreamIndex;
  }
  public set currentAudioStreamIndex(newIndex: number | undefined) {
    this._state.currentAudioStreamIndex = newIndex;
  }

  public get initiator(): BaseItemDto | undefined {
    return this._state.playbackInitiator;
  }

  public get playbackInitMode(): InitMode {
    return this._state.playbackInitMode;
  }

  public get queueIds(): string[] {
    return this._state.queue;
  }

  public get isShuffling(): boolean {
    return this._state.isShuffling;
  }

  public get repeatMode(): RepeatMode {
    return this._state.repeatMode;
  }

  /**
   * In milliseconds
   */
  public get currentItemRuntime(): number {
    return this.currentItem ? getItemRuntime(this.currentItem) : 0;
  }

  /**
   * In milliseconds
   */
  public get currentTime(): number {
    return this.isRemotePlayer
      ? this._state.remotePlaybackTime
      : mediaControls.currentTime.value;
  }
  public set currentTime(newValue: number) {
    if (this.isRemotePlayer) {
      this._state.remotePlaybackTime = newValue;
    } else {
      mediaControls.currentTime.value = newValue;
    }
  }

  public get currentItemIndex(): number | undefined {
    return this._state.currentItemIndex;
  }
  public set currentItemIndex(index: number | undefined) {
    if (this._state.currentItemIndex !== index) {
      this._state.currentItemIndex = index;
      this.currentTime = 0;
    }
  }

  public get currentMediaSource(): MediaSourceInfo | undefined {
    return this._state.currentMediaSource;
  }

  public get isMuted(): boolean {
    return this._state.isRemotePlayer
      ? this._state.isRemoteMuted
      : mediaControls.muted.value;
  }
  private set isMuted(newValue: boolean) {
    if (this._state.isRemotePlayer) {
      this._state.isRemoteMuted = newValue;
    } else {
      mediaControls.muted.value = newValue;
    }
  }

  public get currentVolume(): number {
    return this._state.isRemotePlayer
      ? this._state.remoteCurrentVolume
      : mediaControls.volume.value * 100;
  }
  public set currentVolume(newVolume: number) {
    newVolume = newVolume > 100 ? 100 : newVolume;
    newVolume = newVolume < 0 ? 0 : newVolume;
    this.isMuted = newVolume === 0 ? true : false;

    if (this._state.isRemotePlayer) {
      this._state.remoteCurrentVolume = newVolume;
    } else {
      mediaControls.volume.value = newVolume / 100;
    }
  }

  private get _pendingProgressReport(): boolean {
    return (
      !this._isProgressUpdating &&
      reactiveDate.value.valueOf() - this._state.lastProgressUpdate >=
        progressReportInterval &&
      this.status !== PlaybackStatus.Stopped &&
      this.status !== PlaybackStatus.Error
    );
  }

  /**
   * == ACTIONS ==
   */
  /**
   * Report current item playback progress to server
   */
  private _reportPlaybackProgress = async (): Promise<void> => {
    this._isProgressUpdating = true;

    try {
      if (!isNil(this.currentTime) && !isNil(this.currentItem)) {
        await remote.sdk.newUserApi(getPlaystateApi).reportPlaybackProgress({
          playbackProgressInfo: {
            ItemId: this.currentItem.Id,
            PlaySessionId: this._state.playSessionId,
            IsPaused: this.isPaused,
            PositionTicks: Math.round(msToTicks(this.currentTime * 1000))
          }
        });

        this._state.lastProgressUpdate = Date.now();
      }
    } finally {
      this._isProgressUpdating = false;
    }
  };

  /**
   * Report playback stopped to the server. Used by the "Now playing" statistics in other clients.
   */
  private _reportPlaybackStopped = async (
    itemId: string,
    sessionId = this._state.playSessionId,
    currentTime = this.currentTime,
    updateState = true
  ): Promise<void> => {
    this._isProgressUpdating = true;

    try {
      await remote.sdk.newUserApi(getPlaystateApi).reportPlaybackStopped({
        playbackStopInfo: {
          ItemId: itemId,
          PlaySessionId: sessionId,
          PositionTicks: msToTicks((currentTime || 0) * 1000)
        }
      });

      if (updateState) {
        this._state.lastProgressUpdate = Date.now();
      }
    } finally {
      this._isProgressUpdating = false;
    }
  };

  /**
   * Report playback start to the server. Used by the "Now playing" statistics in other clients.
   */
  private _reportPlaybackStart = async (itemId: string): Promise<void> => {
    this._isProgressUpdating = true;

    try {
      await remote.sdk.newUserApi(getPlaystateApi).reportPlaybackStart({
        playbackStartInfo: {
          CanSeek: true,
          ItemId: itemId,
          PlaySessionId: this._state.playSessionId,
          MediaSourceId: this._state.currentMediaSource?.Id,
          AudioStreamIndex: this._state.currentAudioStreamIndex,
          SubtitleStreamIndex: this._state.currentSubtitleStreamIndex
        }
      });

      this._state.lastProgressUpdate = Date.now();
    } finally {
      this._isProgressUpdating = false;
    }
  };

  public addToQueue = async (item: BaseItemDto): Promise<void> => {
    const translatedItem = await this.translateItemsForPlayback(item);

    this._state.queue.push(...translatedItem);
  };

  public removeFromQueue = (itemId: string): void => {
    if (this._state.queue.includes(itemId)) {
      this._state.queue.splice(this._state.queue.indexOf(itemId), 1);
    }
  };

  public clearQueue = (): void => {
    this._state.queue = [];
  };

  /**
   * Plays an item and initializes playbackManager's state
   */
  public play = async ({
    item,
    audioTrackIndex,
    subtitleTrackIndex,
    videoTrackIndex,
    mediaSourceIndex,
    startFromIndex = 0,
    startFromTime = 0,
    initiator,
    startShuffled = false
  }: {
    item: BaseItemDto;
    audioTrackIndex?: number;
    subtitleTrackIndex?: number;
    videoTrackIndex?: number;
    mediaSourceIndex?: number;
    startFromIndex?: number;
    startFromTime?: number;
    initiator?: BaseItemDto;
    startShuffled?: boolean;
  }): Promise<void> => {
    try {
      if (this._state.status !== PlaybackStatus.Stopped) {
        this.stop();
      }

      this._state.status = PlaybackStatus.Buffering;
      this._state.queue = await this.translateItemsForPlayback(
        item,
        startShuffled
      );

      if (mediaSourceIndex !== undefined) {
        this._state.currentMediaSourceIndex = mediaSourceIndex;
      }

      if (videoTrackIndex !== undefined) {
        this._state.currentVideoStreamIndex = videoTrackIndex;
      }

      if (audioTrackIndex !== undefined) {
        this._state.currentAudioStreamIndex = audioTrackIndex;
      }

      if (subtitleTrackIndex !== undefined) {
        this._state.currentSubtitleStreamIndex = subtitleTrackIndex;
      }

      this._state.currentItemIndex = startFromIndex;
      this.currentTime = startFromTime;

      if (!startShuffled && initiator) {
        this._state.playbackInitMode = InitMode.Item;
      } else if (startShuffled && !initiator) {
        this._state.playbackInitMode = InitMode.Shuffle;
      } else if (startShuffled && initiator) {
        this._state.playbackInitMode = InitMode.ShuffleItem;
      } else {
        this._state.playbackInitMode = InitMode.Unknown;
      }

      this._state.playbackInitiator = initiator;
      this._state.status = PlaybackStatus.Playing;
    } catch {
      this._state.status = PlaybackStatus.Error;
    }
  };

  /**
   * Adds to the queue the items of a collection item (i.e album, tv show, etc...)
   *
   * @param item
   */
  public playNext = async (item: BaseItemDto): Promise<void> => {
    const translatedItem = await this.translateItemsForPlayback(item);

    if (this._state.currentItemIndex !== undefined) {
      /**
       * Removes the elements that already exists and append the new ones next to the currently playing item
       */
      const newQueue = this._state.queue.filter(
        (index) => !translatedItem.includes(index)
      );

      newQueue.splice(this._state.currentItemIndex + 1, 0, ...translatedItem);
      this.setNewQueue(newQueue);
    }
  };

  public pause = (): void => {
    if (this._state.status === PlaybackStatus.Playing) {
      this._state.status = PlaybackStatus.Paused;
    }
  };

  public unpause = (): void => {
    if (this._state.status === PlaybackStatus.Paused) {
      this._state.status = PlaybackStatus.Playing;
    }
  };

  public playPause = (): void => {
    if (this._state.status === PlaybackStatus.Playing) {
      this.pause();
    } else if (this._state.status === PlaybackStatus.Paused) {
      this.unpause();
    }
  };

  public setNextTrack = (): void => {
    if (
      !isNil(this._state.currentItemIndex) &&
      this._state.currentItemIndex + 1 < this._state.queue.length
    ) {
      this._state.currentItemIndex += 1;
      this.currentTime = 0;
    } else if (this._state.repeatMode === RepeatMode.RepeatAll) {
      this._state.currentItemIndex = 0;
      this.currentTime = 0;
    } else {
      this.stop();
    }
  };

  public setPreviousTrack = (): void => {
    if (
      !isNil(this._state.currentItemIndex) &&
      this._state.currentItemIndex > 0 &&
      !isNil(this.currentTime) &&
      this.currentTime < 2
    ) {
      this._state.currentItemIndex -= 1;
    }

    this.currentTime = 0;
  };

  public setNewQueue = (queue: string[]): void => {
    const item =
      this._state.currentItemIndex === undefined
        ? undefined
        : this._state.queue[this._state.currentItemIndex];

    if (item) {
      const newIndex = queue?.indexOf(item);

      this._state.queue = queue;
      this._state.currentItemIndex = newIndex;
    }
  };

  public changeItemPosition = (
    itemId: string | undefined,
    newIndex: number
  ): void => {
    if (itemId && this._state.queue.includes(itemId)) {
      const newQueue = this._state.queue.filter((index) => index !== itemId);

      newQueue.splice(newIndex, 0, itemId);
      this.setNewQueue(newQueue);
    }
  };

  public stop = (): void => {
    const sessionId = String(this._state.playSessionId || '');
    const time = Number(this.currentTime);
    const itemId = String(this.currentItem?.Id || '');
    const volume = Number(this.currentVolume);

    Object.assign(this._state, this._defaultState);
    this.currentVolume = volume;

    window.setTimeout(async () => {
      try {
        if (sessionId && itemId && time && remote.auth.currentUser) {
          await this._reportPlaybackStopped(itemId, sessionId, time, false);
        }
      } catch {}
    });
  };

  public skipForward = (): void => {
    this.currentTime = (this.currentTime || 0) + 15;
  };

  public skipBackward = (): void => {
    this.currentTime =
      (this.currentTime || 0) > 15 ? (this.currentTime || 0) - 15 : 0;
  };

  public toggleShuffle = (): void => {
    if (this._state.queue && !isNil(this._state.currentItemIndex)) {
      if (this._state.isShuffling) {
        const item = this._state.queue[this._state.currentItemIndex];

        this._state.currentItemIndex = this._state.originalQueue.indexOf(item);
        this._state.queue = this._state.originalQueue;
        this._state.originalQueue = [];
        this._state.isShuffling = false;
      } else {
        const queue = shuffle(this._state.queue);

        this._state.originalQueue = this._state.queue;

        const item = this._state.queue[this._state.currentItemIndex];
        const itemIndex = queue.indexOf(item);

        queue.splice(itemIndex, 1);
        queue.unshift(item);

        this._state.queue = queue;
        this._state.currentItemIndex = 0;
        this._state.isShuffling = true;
      }
    }
  };

  /**
   * Toggles between the different repeat modes
   *
   * If there's only one item in queue, we only switch between RepeatOne and RepeatNone
   */
  public toggleRepeatMode = (): void => {
    if (this._state.repeatMode === RepeatMode.RepeatNone) {
      this._state.repeatMode =
        this._state.queue.length > 1
          ? RepeatMode.RepeatAll
          : RepeatMode.RepeatOne;
    } else if (this._state.repeatMode === RepeatMode.RepeatAll) {
      this._state.repeatMode =
        this._state.queue.length > 1
          ? RepeatMode.RepeatOne
          : RepeatMode.RepeatNone;
    } else {
      this._state.repeatMode = RepeatMode.RepeatNone;
    }
  };

  /**
   * Toggles the mute function
   *
   * If the volume is zero and isMuted is true, the volume returns to 100 when it is reactivated
   */
  public toggleMute = (): void => {
    if (this.currentVolume === 0 && this.isMuted) {
      this.currentVolume = 100;
    }

    this.isMuted = !this.isMuted;
  };

  public instantMixFromItem = async (itemId: string): Promise<void> => {
    const items = (
      await remote.sdk.newUserApi(getInstantMixApi).getInstantMixFromItem({
        id: itemId,
        userId: remote.auth.currentUserId,
        limit: 50
      })
    ).data.Items;

    if (!items) {
      throw new Error('No items found');
    }

    for (const item of items) {
      await this.addToQueue(item);
    }
  };

  public getItemPlaybackInfo = async (
    item = this.currentItem,
    mediaSourceIndex = this._state.currentMediaSourceIndex,
    audioStreamIndex = this.currentAudioStreamIndex,
    subtitleStreamIndex = this.currentSubtitleStreamIndex
  ): Promise<PlaybackInfoResponse | undefined> => {
    if (item) {
      return (
        await remote.sdk.newUserApi(getMediaInfoApi).getPostedPlaybackInfo({
          itemId: item?.Id || '',
          userId: remote.auth.currentUserId,
          autoOpenLiveStream: true,
          playbackInfoDto: { DeviceProfile: playbackProfile },
          mediaSourceId:
            item.MediaSources?.[mediaSourceIndex ?? 0].Id ?? item?.Id,
          audioStreamIndex,
          subtitleStreamIndex
        })
      ).data;
    }
  };

  /**
   * Builds an array of item ids based on a collection item (i.e album, tv show, etc...)
   *
   * @param item
   * @param shuffle
   */
  public translateItemsForPlayback = async (
    item: BaseItemDto,
    shuffle = false
  ): Promise<string[]> => {
    if (!item.Id) {
      return [];
    }

    const sortOrder =
      item.Type === BaseItemKind.Playlist || item.Type === BaseItemKind.BoxSet
        ? undefined
        : ['SortName'];
    const sortBy = shuffle ? ['Random'] : sortOrder;
    const ids =
      item.Type === BaseItemKind.Program && item.ChannelId
        ? [item.ChannelId]
        : undefined;
    const artistIds =
      item.Type === BaseItemKind.MusicArtist ? [item.Id] : undefined;
    const parentId = item.IsFolder ? item.Id : undefined;
    let request;

    if (
      item.Type === BaseItemKind.Program ||
      item.Type === BaseItemKind.Playlist ||
      item.Type === BaseItemKind.MusicArtist ||
      item.Type === BaseItemKind.MusicGenre ||
      item.IsFolder
    ) {
      request = await remote.sdk.newUserApi(getItemsApi).getItems({
        ids,
        artistIds,
        filters: [ItemFilter.IsNotFolder],
        parentId,
        recursive: true,
        limit: 300,
        sortBy,
        userId: remote.auth.currentUserId,
        fields: Object.values(ItemFields)
      });
    } else if (
      item.Type === BaseItemKind.Episode &&
      remote.auth.currentUser?.Configuration?.EnableNextEpisodeAutoPlay &&
      item.SeriesId
    ) {
      /**
       * If autoplay is enabled and we have a seriesId, get the rest of the episodes
       */
      request = await remote.sdk.newUserApi(getTvShowsApi).getEpisodes({
        seriesId: item.SeriesId,
        isMissing: false,
        startItemId: item.Id,
        limit: 300,
        userId: remote.auth.currentUserId,
        fields: Object.values(ItemFields)
      });
    }

    /**
     * When no extra processing was needed, we add the item itself
     */
    const responseItems = request ? request.data.Items : [item];

    return (
      responseItems
        ?.filter((i): i is { Id: string } => i.Id !== undefined)
        .map((i) => i.Id) ?? []
    );
  };

  public getItemPlaybackUrl = (
    mediaSource = this.currentMediaSource,
    mediaType = this.currentlyPlayingMediaType
  ): string | undefined => {
    if (
      mediaSource?.SupportsDirectStream &&
      mediaSource.Type &&
      remote.auth.currentUserToken
    ) {
      const directOptions: Record<string, string> = {
        Static: String(true),
        mediaSourceId: String(mediaSource.Id),
        deviceId: remote.sdk.deviceInfo.id,
        api_key: remote.auth.currentUserToken,
        Tag: mediaSource.ETag || '',
        LiveStreamId: mediaSource.LiveStreamId || ''
      };

      const parameters = new URLSearchParams(directOptions).toString();

      return `${remote.sdk.api?.basePath}/${mediaType}/${mediaSource.Id}/stream.${mediaSource.Container}?${parameters}`;
    } else if (mediaSource?.SupportsTranscoding && mediaSource.TranscodingUrl) {
      return remote.sdk.api?.basePath + mediaSource.TranscodingUrl;
    }
  };

  private _setCurrentMediaSource = async (): Promise<void> => {
    /**
     * Generate an identifier that can be compared with the class' one.
     * If they don't match, we assume the playing item has been changed while this function
     * has been running. Hence, it's results are stale and another run will take effect instead.
     */
    const requestId = v4();

    this._mediaSourceRequestId = requestId;
    this._state.status = PlaybackStatus.Buffering;
    /**
     * Set values to undefined so the next item doesn't play the previous one while the requests are in progress
     */
    this._state.playSessionId = undefined;
    this._state.currentMediaSource = undefined;
    this._state.currentSourceUrl = undefined;

    const playbackInfo = await this.getItemPlaybackInfo();

    if (playbackInfo && requestId === this._mediaSourceRequestId) {
      const mediaSource = playbackInfo.MediaSources?.[0];
      const playbackUrl = this.getItemPlaybackUrl(mediaSource);

      if (mediaSource && playbackInfo?.PlaySessionId && playbackUrl) {
        this._state.playSessionId = playbackInfo.PlaySessionId;
        this._state.currentMediaSource = mediaSource;
        this._state.currentSourceUrl = playbackUrl;
      } else {
        const { t } = usei18n();

        this._state.status = PlaybackStatus.Error;
        useSnackbar(t('errors.cantPlayItem'), 'error');
      }

      this._mediaSourceRequestId = undefined;
    }
  };

  public constructor() {
    /**
     * Logic is divided by concerns and scope. Watchers for callbacks
     * that rely on the same variables might not be together. Categories:
     * - Status
     * - MediaSession
     * - Server interaction: Setting media sources and playback reporting
     * - Local media controls: Media element status changes performed outside this store.
     *   For example: The browser itself might expose direct controls to the underlying HTMLMediaElement.
     *   We want to keep track of these changes as well.
     */
    /**
     * == Status ==
     */
    watch(
      () => this.status,
      () => {
        if (
          this.status === PlaybackStatus.Playing &&
          !mediaControls.playing.value
        ) {
          mediaControls.playing.value = true;
        } else if (
          this.status === PlaybackStatus.Paused &&
          mediaControls.playing.value
        ) {
          mediaControls.playing.value = false;
        }
      }
    );

    /**
     * == MediaSession API: https://developer.mozilla.org/en-US/docs/Web/API/MediaSession ==
     */
    watchEffect(() => {
      if (window.navigator.mediaSession) {
        const { t } = usei18n();

        window.navigator.mediaSession.metadata = this.currentItem
          ? new MediaMetadata({
              title: this.currentItem.Name ?? t('unknownTitle'),
              artist: this.currentItem.AlbumArtist ?? t('unknownArtist'),
              album: this.currentItem.Album ?? t('unknownAlbum'),
              artwork: [
                {
                  src:
                    getImageInfo(this.currentItem, {
                      width: 96
                    }).url || '',
                  sizes: '96x96'
                },
                {
                  src:
                    getImageInfo(this.currentItem, {
                      width: 128
                    }).url || '',
                  sizes: '128x128'
                },
                {
                  src:
                    getImageInfo(this.currentItem, {
                      width: 192
                    }).url || '',
                  sizes: '192x192'
                },
                {
                  src:
                    getImageInfo(this.currentItem, {
                      width: 256
                    }).url || '',
                  sizes: '256x256'
                },
                {
                  src:
                    getImageInfo(this.currentItem, {
                      width: 384
                    }).url || '',
                  sizes: '384x384'
                },
                {
                  src:
                    getImageInfo(this.currentItem, {
                      width: 512
                    }).url || '',
                  sizes: '512x512'
                }
              ]
            })
          : // eslint-disable-next-line unicorn/no-null
            null;
      }
    });
    watchEffect(() => {
      if (window.navigator.mediaSession) {
        switch (this.status) {
          case PlaybackStatus.Playing: {
            window.navigator.mediaSession.playbackState = 'playing';
            break;
          }
          case PlaybackStatus.Paused:
          case PlaybackStatus.Buffering: {
            window.navigator.mediaSession.playbackState = 'paused';
            break;
          }
          default: {
            window.navigator.mediaSession.playbackState = 'none';
          }
        }
      }
    });
    watch(
      () => this.status,
      (newValue, oldValue) => {
        const remove =
          newValue === PlaybackStatus.Error ||
          newValue === PlaybackStatus.Stopped;
        const add =
          oldValue === PlaybackStatus.Error ||
          oldValue === PlaybackStatus.Stopped;

        if (window.navigator.mediaSession && (remove || add)) {
          const actionHandlers: {
            [key in MediaSessionAction]?: MediaSessionActionHandler;
          } = {
            play: (): void => {
              this.unpause();
            },
            pause: (): void => {
              this.pause();
            },
            previoustrack: (): void => {
              this.setPreviousTrack();
            },
            nexttrack: (): void => {
              this.setNextTrack();
            },
            stop: (): void => {
              this.stop();
            },
            seekbackward: (): void => {
              this.skipBackward();
            },
            seekforward: (): void => {
              this.skipForward();
            },
            seekto: (action): void => {
              this.currentTime = action.seekTime ?? 0;
            }
          };

          for (const [action, handler] of Object.entries(actionHandlers)) {
            try {
              window.navigator.mediaSession.setActionHandler(
                action as MediaSessionAction,
                // eslint-disable-next-line unicorn/no-null
                add ? handler : null
              );
            } catch {
              console.error(
                `The media session action "${action}" is not supported.`
              );
            }
          }
        }
      }
    );
    watchEffect(() => {
      const remove =
        this.status === PlaybackStatus.Error ||
        this.status === PlaybackStatus.Stopped;

      if (
        window.navigator.mediaSession &&
        this.currentTime <= this.currentItemRuntime
      ) {
        window.navigator.mediaSession.setPositionState(
          remove
            ? undefined
            : {
                duration: this.currentItemRuntime / 1000,
                // TODO: Change this when playback rate changes are implemented
                playbackRate: 1,
                position: this.currentTime
              }
        );
      }
    });

    /**
     * == Server interaction ==
     */
    /**
     * Update media source, taking into account that currentItemIndex updates
     * that occur when shuffling must be skipped
     */
    watch(
      [
        (): typeof this.currentItemIndex => this.currentItemIndex,
        (): typeof this.isShuffling => this.isShuffling
      ],
      async (newValue, oldValue) => {
        if (newValue[1] === oldValue[1]) {
          await this._setCurrentMediaSource();
        }
      }
    );
    /**
     * Report stop for the old item and start for the new one
     */
    watch(
      () => this.currentItem?.Id,
      async (newValue, oldValue) => {
        if (oldValue) {
          await this._reportPlaybackStopped(oldValue);
        }

        if (newValue) {
          await this._reportPlaybackStart(newValue);
        }
      }
    );

    watchEffect(async () => {
      if (
        (this.currentSubtitleTrack?.DeliveryMethod ===
          SubtitleDeliveryMethod.Encode &&
          !isNil(this.currentSubtitleStreamIndex)) ||
        !isNil(this.currentAudioStreamIndex)
      ) {
        /**
         * We need to set a new media source when:
         * - Going from or to a situation where subs are burnt in.
         * - The audio stream index changes
         */
        await this._setCurrentMediaSource();
      }
    });

    watchEffect(async () => {
      if (
        this._pendingProgressReport &&
        this.status !== PlaybackStatus.Buffering
      ) {
        await this._reportPlaybackProgress();
      }
    });
    /**
     * Report playback stop when closing the tab
     */
    useEventListener('beforeunload', async () => {
      if (this.currentItem?.Id) {
        await this._reportPlaybackStopped(this.currentItem.Id);
      }
    });

    /**
     * == Local media controls ==
     */

    watch(mediaControls.playing, () => {
      if (
        playbackManager.status !== PlaybackStatus.Buffering &&
        !this.isRemotePlayer
      ) {
        this._state.status = mediaControls.playing.value
          ? PlaybackStatus.Playing
          : PlaybackStatus.Paused;
      }
    });

    watch(mediaControls.waiting, () => {
      if (!this.isRemotePlayer) {
        this._state.status = mediaControls.waiting.value
          ? PlaybackStatus.Buffering
          : PlaybackStatus.Playing;
      }
    });

    watch(mediaControls.ended, () => {
      if (mediaControls.ended.value && !this.isRemotePlayer) {
        playbackManager.setNextTrack();
      }
    });

    /**
     * Dispose on logout
     */
    watch(
      () => remote.auth.currentUser,
      () => {
        if (isNil(remote.auth.currentUser)) {
          playbackManager.stop();
        }
      }
    );
  }
}

const playbackManager = new PlaybackManagerStore();

export default playbackManager;
