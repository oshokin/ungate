<script lang="ts">
import IconAnthropic from 'virtual:icons/simple-icons/anthropic';
import IconMiniMax from 'virtual:icons/simple-icons/minimax';
import IconOpenAI from 'virtual:icons/simple-icons/openai';

import type { ModelMappingProvider } from '@ungate/shared/frontend';

interface Props {
	provider: ModelMappingProvider;
}

let { provider }: Props = $props();

const providerIcons = {
	claude: IconAnthropic,
	openai: IconOpenAI,
	minimax: IconMiniMax
};
const ProviderIcon = $derived(providerIcons[provider]);
</script>

<span
	class="ug-provider-icon ug-provider-icon-{provider}"
	aria-hidden="true"><ProviderIcon /></span>
