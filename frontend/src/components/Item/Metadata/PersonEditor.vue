<template>
  <v-dialog
    max-width="30%"
    :model-value="person !== undefined"
    @update:model-value="emit('close')">
    <v-card>
      <v-card-title>{{ t('editPerson') }}</v-card-title>
      <v-divider />
      <v-card-text class="pa-3">
        <v-row>
          <v-col cols="4">
            <v-avatar size="160" class="ml-2">
              <v-img
                v-if="person?.Id && person?.PrimaryImageTag"
                :src="
                  $remote.sdk.api?.getItemImageUrl(person.Id, ImageType.Primary)
                " />
              <v-icon v-else class="bg-grey-darken-3">
                <i-mdi-account />
              </v-icon>
            </v-avatar>
          </v-col>
          <v-col>
            <v-form v-if="editState" @submit.prevent="onSubmit">
              <v-text-field
                v-model="editState.Name"
                variant="outlined"
                :label="t('name')" />
              <v-select
                v-model="editState.Type"
                :items="options"
                :label="t('type')"
                item-title="text"
                item-value="value"
                variant="outlined" />
              <v-text-field
                v-if="editState.Type === 'Actor'"
                v-model="editState.Role"
                variant="outlined"
                :label="t('role')" />
            </v-form>
          </v-col>
        </v-row>
      </v-card-text>
      <v-divider />
      <v-card-actions
        class="d-flex align-center pa-3"
        :class="{
          'justify-end': !$vuetify.display.mobile,
          'justify-center': $vuetify.display.mobile
        }">
        <v-spacer />
        <v-btn variant="flat" width="8em" class="mr-1" @click="emit('close')">
          {{ t('cancel') }}
        </v-btn>
        <v-btn variant="flat" width="8em" color="primary" @click="onSubmit">
          {{ t('save') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { BaseItemPerson, ImageType } from '@jellyfin/sdk/lib/generated-client';

const props = defineProps<{ person: BaseItemPerson | undefined }>();

const emit = defineEmits<{
  'update:person': [person: BaseItemPerson];
  close: [];
}>();

const { t } = useI18n();

const editState = ref<BaseItemPerson>();
const options = computed(() => [
  { text: t('actor'), value: 'Actor' },
  { text: t('composer'), value: 'Composer' },
  { text: t('director'), value: 'Director' },
  { text: t('guestStar'), value: 'GuestStar' },
  { text: t('producer'), value: 'Producer' },
  { text: t('writer'), value: 'Writer' }
]);

watch(
  () => props.person,
  (person) => {
    editState.value = { ...person };
  },
  { immediate: true }
);

/**
 * Handles saving person changes
 */
function onSubmit(): void {
  if (!editState.value) {
    return;
  }

  emit('update:person', editState.value);
}
</script>
