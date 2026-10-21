import { Boxes } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

export function Login() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Boxes className="h-5 w-5" />
          </div>
          <CardTitle className="text-lg">InHouseCloud</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Acesso restrito a pessoas autorizadas da empresa.</p>
          <p>Autenticacao protegida pelo Authentik.</p>
        </CardContent>
      </Card>
    </main>
  );
}
