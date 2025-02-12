<template>
  <div>
    <v-select
      v-model="uiCulture"
      :loading="loading"
      variant="outlined"
      :label="t('wizard.preferedLanguage')"
      :rules="SomeItemSelectedRule"
      item-title="Name"
      item-value="Value"
      :items="culturesList"
      :disabled="loading" />
    <v-btn
      color="primary"
      variant="elevated"
      :loading="loading"
      @click="setLanguage">
      {{ t('next') }}
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  LocalizationOption,
  StartupConfigurationDto
} from '@jellyfin/sdk/lib/generated-client';
import { getStartupApi } from '@jellyfin/sdk/lib/utils/api/startup-api';
import { getLocalizationApi } from '@jellyfin/sdk/lib/utils/api/localization-api';
import { useRemote, useSnackbar } from '@/composables';
import { SomeItemSelectedRule } from '@/utils/validation';

const emit = defineEmits<{
  'step-complete': [];
}>();

const remote = useRemote();
const { locale, t } = useI18n();

const uiCulture = ref('en-US');
const culturesList = ref<LocalizationOption[]>([]);
const initialConfig = ref<StartupConfigurationDto>();
const loading = ref(false);

/**
 * Load the intiial server information
 */
onMounted(async () => {
  loading.value = true;

  const api = remote.sdk.oneTimeSetup(
    remote.auth.currentServer?.PublicAddress ?? ''
  );

  try {
    initialConfig.value = (
      await getStartupApi(api).getStartupConfiguration()
    ).data;

    uiCulture.value = initialConfig.value.UICulture ?? 'en-US';

    culturesList.value = (
      await getLocalizationApi(api).getLocalizationOptions()
    ).data;
  } catch (error) {
    console.error(error);
  } finally {
    loading.value = false;
  }
});

/**
 * Set the language locale of the server
 */
async function setLanguage(): Promise<void> {
  loading.value = true;

  const api = remote.sdk.oneTimeSetup(
    remote.auth.currentServer?.PublicAddress ?? ''
  );

  try {
    locale.value = uiCulture.value;
    await getStartupApi(api).updateInitialConfiguration({
      startupConfigurationDto: {
        ...initialConfig.value,
        UICulture: uiCulture.value
      }
    });

    emit('step-complete');
  } catch (error) {
    console.error(error);
    useSnackbar(t('wizard.setLanguageError'), 'error');
  }

  loading.value = false;
}
</script>
