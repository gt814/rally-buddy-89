import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SetupGuide() {
  return (
    <div className="max-w-2xl mx-auto py-12 animate-fade-in">
      <div className="text-center mb-8">
        <span className="text-6xl block mb-4">🏓</span>
        <h2 className="text-2xl font-bold text-foreground">Добро пожаловать!</h2>
        <p className="text-muted-foreground mt-2">
          Бот для бронирования тренировок по настольному теннису
        </p>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground text-sm flex items-center justify-center font-bold">1</span>
              Настройте Webhook
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Отправьте запрос к Telegram API для установки webhook:
            </p>
            <code className="block mt-2 p-3 bg-muted rounded-md text-xs font-mono break-all text-foreground">
              https://api.telegram.org/bot&lt;TOKEN&gt;/setWebhook?url=https://gbptjgtbadzrbnbygykd.supabase.co/functions/v1/telegram-bot
            </code>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground text-sm flex items-center justify-center font-bold">2</span>
              Создайте группу
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Напишите боту: <code className="bg-muted px-2 py-0.5 rounded text-foreground">/newgroup Название группы</code>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground text-sm flex items-center justify-center font-bold">3</span>
              Добавьте расписание
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              <code className="bg-muted px-2 py-0.5 rounded text-foreground">/addschedule ID_ГРУППЫ ДЕНЬ НАЧАЛО КОНЕЦ</code>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Пример: /addschedule abc12 2 20:00 21:30 (Вт, 20:00–21:30)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground text-sm flex items-center justify-center font-bold">4</span>
              Пригласите участников
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Отправьте участникам инвайт-ссылку: <code className="bg-muted px-2 py-0.5 rounded text-foreground">t.me/ваш_бот?start=join_КОД</code>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
