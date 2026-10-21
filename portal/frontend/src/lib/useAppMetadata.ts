import { useState } from 'react';
import { AppStatus, updateAppMetadata } from './api';
import { errorMessage } from './format';

export type AppMetadataForm = {
  category: string;
  lifecycle: string;
  description: string;
  owner_email: string;
  repo_url: string;
  target: string;
  docker_stack: string;
};

const emptyForm: AppMetadataForm = {
  category: 'internal_app',
  lifecycle: 'active',
  description: '',
  owner_email: '',
  repo_url: '',
  target: '',
  docker_stack: '',
};

// Edicao da metadata de um app no inventario (admin), usada no catalogo e na
// pagina do app. `onSaved` recebe o app atualizado devolvido pelo servidor.
export function useAppMetadata({ onSaved }: { onSaved: (app: AppStatus) => void | Promise<void> }) {
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [form, setForm] = useState<AppMetadataForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start(app: AppStatus) {
    setError(null);
    setEditingSlug(app.slug);
    setForm({
      category: app.category || 'internal_app',
      lifecycle: app.lifecycle || 'active',
      description: app.description || '',
      owner_email: app.owner_email || '',
      repo_url: app.repo_url || '',
      target: app.target || '',
      docker_stack: app.docker_stack || app.runtime?.stack || '',
    });
  }

  function update(field: keyof AppMetadataForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save(slug: string) {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateAppMetadata(slug, form);
      setEditingSlug(null);
      await onSaved(updated);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return {
    editingSlug,
    form,
    saving,
    error,
    start,
    update,
    save,
    cancel: () => setEditingSlug(null),
  };
}
