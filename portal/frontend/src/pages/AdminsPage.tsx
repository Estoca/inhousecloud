import { useEffect, useState } from 'react';
import type React from 'react';
import { UserPlus, XCircle } from 'lucide-react';
import { PortalAdmin, User, createAdmin, deactivateAdmin, getAdmins } from '../lib/api';
import { errorMessage } from '../lib/format';
import { PageHeader, RefreshButton } from '../components/portal';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';

// Quem administra o portal (super admin): tabela portal_admins mais os
// bootstrap de SUPER_ADMIN_EMAILS.
export function AdminsPage({ user, emailDomain }: { user: User | null; emailDomain: string }) {
  const [admins, setAdmins] = useState<PortalAdmin[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', name: '', role: 'admin' });

  async function load() {
    setError(null);
    setLoading(true);
    try {
      setAdmins(await getAdmins());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await createAdmin(form);
      setForm({ email: '', name: '', role: 'admin' });
      await load();
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  }

  async function disable(email: string) {
    setError(null);
    try {
      await deactivateAdmin(email);
      await load();
    } catch (disableError) {
      setError(errorMessage(disableError));
    }
  }

  return (
    <>
      <PageHeader title="Admins" description="Acesso administrativo do portal sem edicao manual de variaveis locais.">
        <RefreshButton onClick={() => void load()} loading={loading} />
      </PageHeader>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Novo admin</CardTitle>
        </CardHeader>
        <CardContent className="p-5">
          <form className="grid gap-3 lg:grid-cols-[1fr_1fr_160px_auto]" onSubmit={submit}>
            <Input
              placeholder={`email@${emailDomain}`}
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
            />
            <Input
              placeholder="Nome"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={form.role}
              onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
            >
              <option value="admin">Admin</option>
              <option value="super_admin">Super admin</option>
              <option value="viewer">Viewer</option>
            </select>
            <Button type="submit">
              <UserPlus className="h-4 w-4" />
              Adicionar
            </Button>
          </form>
          {error ? <div className="mt-3 text-sm text-destructive">Erro: {error}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Usuarios autorizados</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{admins.length} usuarios cadastrados ou bootstrap</p>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Usuario</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Origem</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Acao</th>
                  </tr>
                </thead>
                <tbody>
                  {admins.map((admin) => (
                    <tr key={admin.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{admin.name || admin.email}</div>
                        <div className="text-xs text-muted-foreground">{admin.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={admin.role === 'super_admin' ? 'success' : 'secondary'}>{admin.role}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={admin.source === 'env' ? 'warning' : 'secondary'}>{admin.source}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={admin.active ? 'success' : 'secondary'}>{admin.active ? 'Ativo' : 'Inativo'}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          disabled={!admin.active || admin.source === 'env' || admin.email === user?.email}
                          onClick={() => void disable(admin.email)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <XCircle className="h-4 w-4" />
                          Desativar
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
