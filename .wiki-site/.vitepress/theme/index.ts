import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import PageLead from './PageLead.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'doc-before': () => h(PageLead),
    }),
};
