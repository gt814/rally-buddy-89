# Rally Buddy — архитектура

## Общая схема компонентов

```mermaid
flowchart TB
    subgraph clients["Клиенты"]
        TG[Telegram]
        WEB[Web-панель]
    end

    subgraph supabase["Supabase"]
        BOT[Edge: telegram-bot]
        GEN[Edge: generate-weekly-sessions]
        DB[(PostgreSQL)]
    end

    TG -->|Webhook POST /Update| BOT
    WEB -->|Supabase client| DB
    BOT -->|Service role| DB
    GEN -->|Service role| DB
    GEN -.->|Cron / ручной вызов| GEN
```

## Потоки данных

```mermaid
flowchart LR
    subgraph input["Ввод"]
        U[Пользователь]
    end

    subgraph bot["Telegram Bot"]
        H[handleUpdate]
        START[/start, join]
        MENU[Меню]
        Sched[Расписание]
        Book[Запись/отмена]
        Admin[Админка]
    end

    subgraph data["Данные"]
        UU[bot_users]
        G[groups]
        GM[group_members]
        GA[group_admins]
        SCH[schedules]
        S[sessions]
        B[bookings]
    end

    U --> H
    H --> START --> MENU
    MENU --> Sched
    MENU --> Book
    MENU --> Admin
    H --> UU
    H --> G
    H --> GM
    H --> GA
    Sched --> SCH
    Sched --> S
    Book --> B
```

## Слой базы данных (основные сущности)

```mermaid
erDiagram
    bot_users ||--o{ group_members : "user_id"
    bot_users ||--o{ group_admins : "user_id"
    bot_users ||--o{ bookings : "user_id"

    groups ||--o{ group_members : "group_id"
    groups ||--o{ group_admins : "group_id"
    groups ||--o{ schedules : "group_id"
    groups ||--o{ sessions : "group_id"

    schedules ||--o{ sessions : "schedule_id"

    sessions ||--o{ bookings : "session_id"

    bot_users {
        uuid id PK
        bigint telegram_id
        string username
        string first_name
        boolean is_super_admin
    }

    groups {
        uuid id PK
        string name
        string invite_code
        int max_participants
        int freeze_hours
        string timezone
    }

    schedules {
        uuid id PK
        uuid group_id FK
        int day_of_week
        time start_time
        time end_time
    }

    sessions {
        uuid id PK
        uuid group_id FK
        uuid schedule_id FK
        date date
        time start_time
        time end_time
        enum status
        int max_participants
    }

    bookings {
        uuid id PK
        uuid session_id FK
        uuid user_id FK
        enum status
        int waitlist_position
    }
```

## Сценарий: запись на тренировку

```mermaid
sequenceDiagram
    participant U as Пользователь
    participant TG as Telegram
    participant Bot as telegram-bot
    participant DB as PostgreSQL

    U->>TG: Нажимает "Записаться"
    TG->>Bot: callback_query book_&lt;sessionId&gt;
    Bot->>DB: getOrCreateUser, session, membership
    Bot->>Bot: freeze_hours? banned?
    Bot->>DB: count active bookings
    alt Есть место
        Bot->>DB: insert booking status=active
        Bot->>TG: "Вы записаны"
    else Нет места
        Bot->>DB: insert booking status=waitlist
        Bot->>TG: "Вы в очереди"
    end
```

## Сценарий: отмена и продвижение из очереди

```mermaid
sequenceDiagram
    participant U as Пользователь
    participant Bot as telegram-bot
    participant DB as PostgreSQL
    participant U2 as Участник из очереди

    U->>Bot: confirm_cancel_&lt;sessionId&gt;
    Bot->>DB: update booking → cancelled
    Bot->>DB: select first waitlist
    alt Есть в очереди
        Bot->>DB: update waitlist → active
        Bot->>U2: sendMessage "Место освободилось!"
    end
    Bot->>U: "Запись отменена"
```

## Генерация сессий

```mermaid
flowchart LR
    subgraph trigger["Триггер"]
        A[Открытие расписания в боте]
        B[Cron / вызов функции]
    end

    subgraph gen["Генерация"]
        S[schedules по group_id]
        D[День 0..13]
        U[upsert sessions]
    end

    A --> gen
    B --> gen
    S --> D --> U
```
